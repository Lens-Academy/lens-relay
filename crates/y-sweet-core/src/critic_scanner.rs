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
    /// 1-based line number where the suggestion starts in the document.
    pub line: usize,
}

static ADDITION_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)\{\+\+(.*?)\+\+\}").unwrap());
static DELETION_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)\{--(.*?)--\}").unwrap());
static SUBSTITUTION_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)\{~~(.*?)~>(.*?)~~\}").unwrap());

/// Budget for context extraction. Newlines cost more to keep context compact.
const CONTEXT_BUDGET: usize = 200;
const NEWLINE_COST: usize = 50;

/// Regex to clean up partial/broken CriticMarkup fragments at context boundaries.
/// Matches partial opening/closing delimiters and leftover metadata.
static PARTIAL_MARKUP_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?s)",
        // Partial closing tags at start: ...content++} or ...content--} or ...content~~}
        r"^[^{]*?(?:\+\+\}|--\}|~~\})",
        r"|",
        // Partial opening tags at end: {++content... or {--content... or {~~content...
        r"(?:\{\+\+|\{--|\{~~)[^}]*$",
    ))
    .unwrap()
});

/// Strip CriticMarkup syntax from text, keeping just the readable content.
/// Additions: keep added text. Deletions: keep deleted text. Substitutions: keep old text.
/// Metadata (`{...}@@`) is stripped from all.
fn strip_critic_markup(text: &str) -> String {
    // Strip complete markup patterns first
    let result = SUBSTITUTION_RE.replace_all(text, |caps: &regex::Captures| {
        let raw_old = caps.get(1).unwrap().as_str();
        let (_, _, old_content) = extract_metadata(raw_old);
        let new_content = caps.get(2).unwrap().as_str();
        format!("{}/{}", old_content, new_content)
    });
    let result = ADDITION_RE.replace_all(&result, |caps: &regex::Captures| {
        let raw = caps.get(1).unwrap().as_str();
        let (_, _, content) = extract_metadata(raw);
        content.to_string()
    });
    let result = DELETION_RE.replace_all(&result, |caps: &regex::Captures| {
        let raw = caps.get(1).unwrap().as_str();
        let (_, _, content) = extract_metadata(raw);
        content.to_string()
    });
    // Clean up partial/broken markup at boundaries
    let result = PARTIAL_MARKUP_RE.replace_all(&result, "");
    result.into_owned()
}

/// Walk backwards from `start` spending budget (newlines cost NEWLINE_COST, other chars cost 1).
fn budget_scan_back(text: &str, start: usize) -> usize {
    let mut budget = CONTEXT_BUDGET;
    let mut pos = start;
    for ch in text[..start].chars().rev() {
        let cost = if ch == '\n' { NEWLINE_COST } else { 1 };
        if cost > budget {
            break;
        }
        budget -= cost;
        pos -= ch.len_utf8();
    }
    pos
}

/// Walk forwards from `start` spending budget (newlines cost NEWLINE_COST, other chars cost 1).
fn budget_scan_forward(text: &str, start: usize) -> usize {
    let mut budget = CONTEXT_BUDGET;
    let mut pos = start;
    for ch in text[start..].chars() {
        let cost = if ch == '\n' { NEWLINE_COST } else { 1 };
        if cost > budget {
            break;
        }
        budget -= cost;
        pos += ch.len_utf8();
    }
    pos
}

fn extract_context(text: &str, from: usize, to: usize) -> (String, String) {
    let before_start = budget_scan_back(text, from);
    let after_end = budget_scan_forward(text, to);
    let context_before = strip_critic_markup(&text[before_start..from]);
    let context_after = strip_critic_markup(&text[to..after_end]);
    (context_before, context_after)
}

fn extract_metadata(raw: &str) -> (Option<String>, Option<u64>, &str) {
    if let Some(sep_pos) = raw.find("@@") {
        let meta_str = &raw[..sep_pos];
        if meta_str.starts_with('{') && meta_str.ends_with('}') {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(meta_str) {
                let author = json
                    .get("author")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
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
        let line = text[..m.start()].matches('\n').count() + 1;
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
            line,
        });
    }

    for m in DELETION_RE.find_iter(text) {
        let raw_markup = m.as_str().to_string();
        let raw = &text[m.start() + 3..m.end() - 3]; // strip {-- and --}
        let (author, timestamp, content) = extract_metadata(raw);
        let (ctx_before, ctx_after) = extract_context(text, m.start(), m.end());
        let line = text[..m.start()].matches('\n').count() + 1;
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
            line,
        });
    }

    for caps in SUBSTITUTION_RE.captures_iter(text) {
        let m = caps.get(0).unwrap();
        let raw_markup = m.as_str().to_string();
        let raw_old = caps.get(1).unwrap().as_str();
        let new_content = caps.get(2).unwrap().as_str();
        let (author, timestamp, old_content) = extract_metadata(raw_old);
        let (ctx_before, ctx_after) = extract_context(text, m.start(), m.end());
        let line = text[..m.start()].matches('\n').count() + 1;
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
            line,
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
        // Context should be truncated to ~200 chars
        let long_before = "a".repeat(300);
        let text = format!(
            "{} {{++{{\"author\":\"AI\",\"timestamp\":1000}}@@added++}} after",
            long_before
        );
        let results = scan_suggestions(&text);
        assert_eq!(results.len(), 1);
        assert!(results[0].context_before.len() <= 210);
        assert!(results[0].context_before.len() >= 190);
    }

    #[test]
    fn test_context_strips_critic_markup() {
        // Context from neighboring suggestions should have markup stripped
        let text = r#"{++{"author":"AI","timestamp":1000}@@first addition++} some text {--{"author":"AI","timestamp":2000}@@deleted part--} end"#;
        let results = scan_suggestions(&text);
        assert_eq!(results.len(), 2);
        // The deletion's context_before should NOT contain {++...++} markup
        assert!(!results[1].context_before.contains("{++"));
        assert!(results[1].context_before.contains("first addition"));
        // The addition's context_after should NOT contain {--...--} markup
        assert!(!results[0].context_after.contains("{--"));
        assert!(results[0].context_after.contains("deleted part"));
    }
}
