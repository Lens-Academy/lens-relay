use regex::Regex;
use serde::Serialize;
use std::sync::LazyLock;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SuggestionType {
    Addition,
    Deletion,
    Substitution,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Suggestion {
    #[serde(rename = "type")]
    pub suggestion_type: SuggestionType,
    pub content: String,
    pub old_content: Option<String>,
    pub new_content: Option<String>,
    pub author: Option<String>,
    pub timestamp: Option<u64>,
    pub from: usize,
    pub to: usize,
    /// The raw CriticMarkup string as it appears in the document (e.g. `{++meta@@text++}`).
    /// Used by the frontend to locate and replace the suggestion without reconstructing it.
    pub raw_markup: String,
    pub context_before: String,
    pub context_after: String,
}

static ADDITION_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)\{\+\+(.*?)\+\+\}").unwrap()
});
static DELETION_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)\{--(.*?)--\}").unwrap()
});
static SUBSTITUTION_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)\{~~(.*?)~>(.*?)~~\}").unwrap()
});

const CONTEXT_CHARS: usize = 50;

fn extract_context(text: &str, from: usize, to: usize) -> (String, String) {
    let before_start = text.floor_char_boundary(from.saturating_sub(CONTEXT_CHARS));
    let after_end = text.ceil_char_boundary((to + CONTEXT_CHARS).min(text.len()));
    let context_before = &text[before_start..from];
    let context_after = &text[to..after_end];
    (context_before.to_string(), context_after.to_string())
}

fn extract_metadata(raw: &str) -> (Option<String>, Option<u64>, &str) {
    if let Some(sep_pos) = raw.find("@@") {
        let meta_str = &raw[..sep_pos];
        if meta_str.starts_with('{') && meta_str.ends_with('}') {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(meta_str) {
                let author = json.get("author").and_then(|v| v.as_str()).map(|s| s.to_string());
                let timestamp = json.get("timestamp").and_then(|v| v.as_u64());
                let content = &raw[sep_pos + 2..];
                return (author, timestamp, content);
            }
        }
    }
    (None, None, raw)
}

pub fn scan_suggestions(text: &str) -> Vec<Suggestion> {
    let mut suggestions = Vec::new();

    for m in ADDITION_RE.find_iter(text) {
        let raw_markup = m.as_str().to_string();
        let raw = &text[m.start() + 3..m.end() - 3]; // strip {++ and ++}
        let (author, timestamp, content) = extract_metadata(raw);
        let (ctx_before, ctx_after) = extract_context(text, m.start(), m.end());
        suggestions.push(Suggestion {
            suggestion_type: SuggestionType::Addition,
            content: content.to_string(),
            old_content: None,
            new_content: None,
            author,
            timestamp,
            from: m.start(),
            to: m.end(),
            raw_markup,
            context_before: ctx_before,
            context_after: ctx_after,
        });
    }

    for m in DELETION_RE.find_iter(text) {
        let raw_markup = m.as_str().to_string();
        let raw = &text[m.start() + 3..m.end() - 3]; // strip {-- and --}
        let (author, timestamp, content) = extract_metadata(raw);
        let (ctx_before, ctx_after) = extract_context(text, m.start(), m.end());
        suggestions.push(Suggestion {
            suggestion_type: SuggestionType::Deletion,
            content: content.to_string(),
            old_content: None,
            new_content: None,
            author,
            timestamp,
            from: m.start(),
            to: m.end(),
            raw_markup,
            context_before: ctx_before,
            context_after: ctx_after,
        });
    }

    for caps in SUBSTITUTION_RE.captures_iter(text) {
        let m = caps.get(0).unwrap();
        let raw_markup = m.as_str().to_string();
        let raw_old = caps.get(1).unwrap().as_str();
        let new_content = caps.get(2).unwrap().as_str();
        let (author, timestamp, old_content) = extract_metadata(raw_old);
        let (ctx_before, ctx_after) = extract_context(text, m.start(), m.end());
        suggestions.push(Suggestion {
            suggestion_type: SuggestionType::Substitution,
            content: format!("{}>{}", old_content, new_content),
            old_content: Some(old_content.to_string()),
            new_content: Some(new_content.to_string()),
            author,
            timestamp,
            from: m.start(),
            to: m.end(),
            raw_markup,
            context_before: ctx_before,
            context_after: ctx_after,
        });
    }

    suggestions.sort_by_key(|s| s.from);
    suggestions
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scan_addition() {
        let text = r#"Hello {++{"author":"AI","timestamp":1709900000000}@@world++} end"#;
        let results = scan_suggestions(text);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].suggestion_type, SuggestionType::Addition);
        assert_eq!(results[0].content, "world");
        assert_eq!(results[0].author.as_deref(), Some("AI"));
        assert_eq!(results[0].timestamp, Some(1709900000000));
        assert_eq!(results[0].context_before, "Hello ");
        assert_eq!(results[0].context_after, " end");
        assert_eq!(
            results[0].raw_markup,
            r#"{++{"author":"AI","timestamp":1709900000000}@@world++}"#
        );
    }

    #[test]
    fn test_scan_deletion() {
        let text = r#"Keep {--{"author":"AI","timestamp":1000}@@removed--} this"#;
        let results = scan_suggestions(text);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].suggestion_type, SuggestionType::Deletion);
        assert_eq!(results[0].content, "removed");
        assert_eq!(
            results[0].raw_markup,
            r#"{--{"author":"AI","timestamp":1000}@@removed--}"#
        );
    }

    #[test]
    fn test_scan_substitution() {
        let text = r#"Say {~~{"author":"AI","timestamp":2000}@@hello~>goodbye~~} now"#;
        let results = scan_suggestions(text);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].suggestion_type, SuggestionType::Substitution);
        assert_eq!(results[0].old_content.as_deref(), Some("hello"));
        assert_eq!(results[0].new_content.as_deref(), Some("goodbye"));
        assert_eq!(
            results[0].raw_markup,
            r#"{~~{"author":"AI","timestamp":2000}@@hello~>goodbye~~}"#
        );
    }

    #[test]
    fn test_scan_no_metadata() {
        let text = "Hello {++plain addition++} end";
        let results = scan_suggestions(text);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].content, "plain addition");
        assert!(results[0].author.is_none());
        assert!(results[0].timestamp.is_none());
        assert_eq!(results[0].raw_markup, "{++plain addition++}");
    }

    #[test]
    fn test_scan_multiple() {
        let text = r#"{++{"author":"AI","timestamp":1000}@@added++} middle {--{"author":"Bob","timestamp":2000}@@deleted--}"#;
        let results = scan_suggestions(text);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].suggestion_type, SuggestionType::Addition);
        assert_eq!(results[1].suggestion_type, SuggestionType::Deletion);
    }

    #[test]
    fn test_scan_empty() {
        let results = scan_suggestions("No suggestions here");
        assert!(results.is_empty());
    }

    #[test]
    fn test_context_truncation() {
        // Context should be truncated to ~50 chars
        let long_before = "a".repeat(100);
        let text = format!("{} {{++{{\"author\":\"AI\",\"timestamp\":1000}}@@added++}} after", long_before);
        let results = scan_suggestions(&text);
        assert_eq!(results.len(), 1);
        assert!(results[0].context_before.len() <= 60); // some leeway for word boundary
    }
}
