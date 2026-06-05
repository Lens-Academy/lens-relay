//! # Why are MCP sessions managed by an MCP *tool* instead of the transport?
//!
//! At first glance this design looks backwards — the streamable-HTTP MCP
//! transport already has a session mechanism (`mcp-session-id` header), so why
//! make the LLM thread an `session_id` argument through every tool call?
//!
//! Claude.ai connects to us through the Anthropic Proxy, which is
//! request-scoped: each MCP call is an independent HTTP exchange, and the
//! proxy does not carry transport-layer session state across them. The only
//! place we can store session identity that survives between calls is *inside
//! the JSON-RPC payload itself* — i.e. the LLM has to call a `create_session`
//! tool, receive the id back, and quote it on every subsequent tool call.
//!
//! Once that machinery exists for Claude.ai, the simplest design is to use
//! the same flow for Claude Code: the transport stays fully stateless (no
//! `mcp-session-id` header is ever issued or required), and the LLM manages
//! the session lifecycle directly via the `create_session` tool. If we only
//! ever had to support Claude Code we'd let the streamable-HTTP transport
//! handle session ids automatically — but running two parallel mechanisms
//! (transport-managed for one client, tool-managed for the other) doubles the
//! code and the failure surface.
//!
//! As a side benefit, this design routes around the known Claude Code
//! reconnect bug (anthropics/claude-code#9608): when a session expires the
//! LLM sees a plain `isError: true` tool result instead of an HTTP 4xx, and
//! recovers by calling `create_session` again — no `/mcp reconnect` needed.

use dashmap::DashMap;
use std::collections::HashSet;
use std::time::Instant;
use y_sweet_core::share_token::McpAccess;

/// Maximum app-session age before cleanup. App sessions are allocated by the
/// `create_session` MCP tool; the LLM passes the returned id as a parameter to
/// every other tool call. Sessions are pruned after this idle period — when the
/// LLM hits an expired/missing id, it sees the existing "Invalid session_id"
/// tool-result error and re-creates a session, no human intervention needed.
const SESSION_TTL: std::time::Duration = std::time::Duration::from_secs(7 * 24 * 60 * 60);

/// Opportunistic-cleanup threshold. When `create_session` is called and the
/// session map already holds at least this many entries, we run a cleanup
/// pass before inserting. Keeps memory bounded under pathological traffic
/// without paying for a cleanup on every allocation.
const CLEANUP_THRESHOLD: usize = 1000;

pub struct McpSession {
    pub session_id: String,
    pub created_at: Instant,
    pub last_activity: Instant,
    pub read_docs: HashSet<String>,
    pub access: McpAccess,
    /// Author label stamped on CriticMarkup suggestions: "AI" or "{name}'s AI".
    pub author_name: String,
}

pub struct SessionManager {
    sessions: DashMap<String, McpSession>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: DashMap::new(),
        }
    }

    /// Time-to-live applied by periodic cleanup.
    pub const fn ttl() -> std::time::Duration {
        SESSION_TTL
    }

    /// Allocate a new app session, returning the session ID.
    ///
    /// `human_name` is the name of the human on whose behalf the AI is acting
    /// (e.g. "Chris"). When provided, suggestions are attributed to "{name}'s AI"
    /// instead of the generic "AI". Pass `None` to use the default "AI" label.
    ///
    /// Runs an opportunistic cleanup pass when the map is over
    /// `CLEANUP_THRESHOLD` entries, so memory stays bounded even between runs
    /// of the periodic cleanup task.
    pub fn create_session(&self, access: McpAccess, human_name: Option<&str>) -> String {
        if self.sessions.len() >= CLEANUP_THRESHOLD {
            self.cleanup_stale(SESSION_TTL);
        }
        let author_name = match human_name {
            Some(name) if !name.trim().is_empty() => format!("{}'s AI", name.trim()),
            _ => "AI".to_string(),
        };
        let session_id = nanoid::nanoid!(8);
        let now = Instant::now();
        let session = McpSession {
            session_id: session_id.clone(),
            created_at: now,
            last_activity: now,
            read_docs: HashSet::new(),
            access,
            author_name,
        };
        self.sessions.insert(session_id.clone(), session);
        session_id
    }

    /// Look up a session by ID.
    pub fn get_session(
        &self,
        session_id: &str,
    ) -> Option<dashmap::mapref::one::Ref<'_, String, McpSession>> {
        self.sessions.get(session_id)
    }

    /// Get a mutable reference to a session.
    pub fn get_session_mut(
        &self,
        session_id: &str,
    ) -> Option<dashmap::mapref::one::RefMut<'_, String, McpSession>> {
        self.sessions.get_mut(session_id)
    }

    /// Refresh `last_activity` for an existing session. No-op if session is gone.
    pub fn touch(&self, session_id: &str) {
        if let Some(mut session) = self.sessions.get_mut(session_id) {
            session.last_activity = Instant::now();
        }
    }

    /// Remove a session. Returns true if session existed.
    pub fn remove_session(&self, session_id: &str) -> bool {
        self.sessions.remove(session_id).is_some()
    }

    /// Remove sessions whose `last_activity` is older than `max_age`.
    ///
    /// Uses `checked_duration_since` to avoid panicking when the host's
    /// monotonic clock is younger than `max_age` (e.g. a freshly-rebooted VPS
    /// running with a 7-day TTL — `Instant::now() - 7d` would underflow).
    pub fn cleanup_stale(&self, max_age: std::time::Duration) {
        let now = Instant::now();
        self.sessions.retain(|_, session| {
            match now.checked_duration_since(session.last_activity) {
                Some(age) => age < max_age,
                // last_activity is in the future relative to `now` (clock
                // anomaly). Keep the session — it's clearly fresh.
                None => true,
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_access() -> McpAccess {
        McpAccess {
            writable: true,
            folder_uuid: None,
            folder_name: None,
        }
    }

    #[test]
    fn create_session_returns_8_char_id() {
        let mgr = SessionManager::new();
        let id = mgr.create_session(default_access(), None);
        assert_eq!(id.len(), 8);
    }

    #[test]
    fn create_session_no_name_defaults_to_ai() {
        let mgr = SessionManager::new();
        let id = mgr.create_session(default_access(), None);
        let session = mgr.get_session(&id).unwrap();
        assert_eq!(session.author_name, "AI");
    }

    #[test]
    fn create_session_with_name_formats_possessive() {
        let mgr = SessionManager::new();
        let id = mgr.create_session(default_access(), Some("Chris"));
        let session = mgr.get_session(&id).unwrap();
        assert_eq!(session.author_name, "Chris's AI");
    }

    #[test]
    fn create_session_trims_whitespace_in_name() {
        let mgr = SessionManager::new();
        let id = mgr.create_session(default_access(), Some("  Luc  "));
        let session = mgr.get_session(&id).unwrap();
        assert_eq!(session.author_name, "Luc's AI");
    }

    #[test]
    fn create_session_empty_name_defaults_to_ai() {
        let mgr = SessionManager::new();
        let id = mgr.create_session(default_access(), Some("   "));
        let session = mgr.get_session(&id).unwrap();
        assert_eq!(session.author_name, "AI");
    }

    #[test]
    fn two_sessions_have_different_ids() {
        let mgr = SessionManager::new();
        let id1 = mgr.create_session(default_access(), None);
        let id2 = mgr.create_session(default_access(), None);
        assert_ne!(id1, id2);
    }

    #[test]
    fn get_session_valid_id() {
        let mgr = SessionManager::new();
        let id = mgr.create_session(default_access(), None);
        let session = mgr.get_session(&id).expect("session should exist");
        assert_eq!(session.session_id, id);
        assert!(session.read_docs.is_empty());
    }

    #[test]
    fn get_session_invalid_id() {
        let mgr = SessionManager::new();
        assert!(mgr.get_session("nonexistent").is_none());
    }

    #[test]
    fn touch_updates_last_activity() {
        let mgr = SessionManager::new();
        let id = mgr.create_session(default_access(), None);

        // Backdate last_activity so we can detect the touch.
        {
            let mut session = mgr.get_session_mut(&id).unwrap();
            session.last_activity = Instant::now() - std::time::Duration::from_secs(60);
        }
        let before = mgr.get_session(&id).unwrap().last_activity;

        mgr.touch(&id);

        let after = mgr.get_session(&id).unwrap().last_activity;
        assert!(after > before);
    }

    #[test]
    fn touch_nonexistent_is_noop() {
        let mgr = SessionManager::new();
        mgr.touch("nonexistent"); // must not panic
    }

    #[test]
    fn remove_session_makes_it_inaccessible() {
        let mgr = SessionManager::new();
        let id = mgr.create_session(default_access(), None);
        assert!(mgr.get_session(&id).is_some());
        assert!(mgr.remove_session(&id));
        assert!(mgr.get_session(&id).is_none());
    }

    #[test]
    fn remove_nonexistent_session_returns_false() {
        let mgr = SessionManager::new();
        assert!(!mgr.remove_session("nonexistent"));
    }

    #[test]
    fn read_docs_can_be_modified() {
        let mgr = SessionManager::new();
        let id = mgr.create_session(default_access(), None);

        {
            let mut session = mgr.get_session_mut(&id).unwrap();
            session.read_docs.insert("doc-123".to_string());
        }

        let session = mgr.get_session(&id).unwrap();
        assert!(session.read_docs.contains("doc-123"));
        assert_eq!(session.read_docs.len(), 1);
    }

    #[test]
    fn cleanup_stale_removes_old_sessions() {
        let mgr = SessionManager::new();
        let id = mgr.create_session(default_access(), None);
        assert!(mgr.get_session(&id).is_some());

        mgr.cleanup_stale(std::time::Duration::from_secs(0));

        assert!(mgr.get_session(&id).is_none());
    }

    #[test]
    fn cleanup_stale_keeps_fresh_sessions() {
        let mgr = SessionManager::new();
        let id = mgr.create_session(default_access(), None);

        mgr.cleanup_stale(std::time::Duration::from_secs(3600));

        assert!(mgr.get_session(&id).is_some());
    }

    #[test]
    fn touch_keeps_session_alive_past_ttl() {
        let mgr = SessionManager::new();
        let id = mgr.create_session(default_access(), None);

        // Backdate last_activity beyond a 30s TTL.
        {
            let mut session = mgr.get_session_mut(&id).unwrap();
            session.last_activity = Instant::now() - std::time::Duration::from_secs(60);
        }

        // Refresh and confirm cleanup keeps it.
        mgr.touch(&id);
        mgr.cleanup_stale(std::time::Duration::from_secs(30));

        assert!(mgr.get_session(&id).is_some());
    }
}
