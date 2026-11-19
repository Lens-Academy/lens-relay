//! Transcripts of Cap (cap.so) recordings linked in a document, shown in
//! `read` output so an AI can follow what the videos say.
//!
//! Cap transcribes each recording itself and stores the result as WebVTT at
//! v.cap.so/<ownerId>/<videoId>/transcription.vtt, readable without sign-in for
//! any public share. The owner id appears only in the share page, and loading
//! the share page is also what makes Cap start transcribing. So one share-page
//! fetch tells us the owner and whether the transcript is COMPLETE; `read`
//! never waits for Cap, it reports "pending" and the next read gets it.
//! lens-platform's `core/cap_recordings.py` does the same for Cap links posted
//! in Discord; keep the two in step if Cap changes its page.

use dashmap::DashMap;
use regex::Regex;
use std::sync::{LazyLock, OnceLock};
use std::time::Duration;

static SHARE_LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"https?://(?:www\.)?cap\.so/s/([A-Za-z0-9]+)").unwrap());
// The share page embeds the video row as JSON inside a JS string, so its
// quotes arrive escaped; parse after unescaping them.
static OWNER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""owner":\{"id":"([A-Za-z0-9]+)""#).unwrap());
static STATUS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""transcriptionStatus":(?:"([A-Z_]+)"|null)"#).unwrap());
// WebVTT is blocks split by blank lines. A cue block has this timing line
// (hours optional, cue settings after it); its text is the lines below.
static TIMING: LazyLock<Regex> = LazyLock::new(|| {
    let t = r"(?:(\d+):)?(\d\d):(\d\d\.\d+)";
    Regex::new(&format!(r"(?m)^{t} --> {t}.*$")).unwrap()
});
static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]+>").unwrap());
static BLANK_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n\s*\n").unwrap());
// Speech models hear the Dutch name "Luc" as "Luke".
static LUKE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\bLuke\b").unwrap());

/// A pause this long after a finished sentence starts a new paragraph.
const PARAGRAPH_PAUSE: f64 = 1.5;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

const BLOCK_START: &str =
    "── Transcripts of the Cap videos linked in this file (context — NOT part of this file's text) ──";
const BLOCK_END: &str = "── end of Cap video transcripts ──";

/// What Cap has for one recording.
#[derive(Debug, Clone, PartialEq)]
pub enum Transcript {
    Ready(String),
    /// Cap is still transcribing (or has just been asked to).
    Pending,
    /// Cap has no transcript and will not get one by waiting; the reason
    /// completes "No transcript: <reason>."
    Unavailable(String),
}

/// Finished transcripts never change, so they are kept for the life of the
/// process. Pending and unavailable answers are asked again on the next read.
static CACHE: LazyLock<DashMap<String, String>> = LazyLock::new(DashMap::new);

/// Video ids of the Cap share links in `text`, first-seen order.
pub fn video_ids(text: &str) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for c in SHARE_LINK.captures_iter(text) {
        if !ids.iter().any(|id| id == &c[1]) {
            ids.push(c[1].to_string());
        }
    }
    ids
}

fn seconds(h: Option<regex::Match>, m: &str, s: &str) -> f64 {
    let h: f64 = h.map_or(0.0, |h| h.as_str().parse().unwrap_or(0.0));
    h * 3600.0 + m.parse::<f64>().unwrap_or(0.0) * 60.0 + s.parse::<f64>().unwrap_or(0.0)
}

/// Join WebVTT cues into prose, one paragraph per pause between sentences.
pub fn vtt_to_text(vtt: &str) -> String {
    let mut out = String::new();
    let mut prev_end = 0.0;
    for block in BLANK_LINE.split(&vtt.replace("\r\n", "\n")) {
        let Some(c) = TIMING.captures(block) else {
            continue;
        };
        let body = &block[c.get(0).unwrap().end()..];
        let text = TAG
            .replace_all(body, "")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if text.is_empty() {
            continue;
        }
        if !out.is_empty() {
            let paused = seconds(c.get(1), &c[2], &c[3]) - prev_end > PARAGRAPH_PAUSE;
            let ends_sentence = out.ends_with(['.', '?', '!']);
            out.push_str(if paused && ends_sentence { "\n\n" } else { " " });
        }
        out.push_str(&text);
        prev_end = seconds(c.get(4), &c[5], &c[6]);
    }
    LUKE.replace_all(&out, "Luc").into_owned()
}

/// What a share page says: the owner id when the share is public, and the
/// transcript status.
fn parse_share_page(html: &str) -> (Option<String>, Option<String>) {
    let html = html.replace("\\\"", "\"");
    let owner = OWNER.captures(&html).map(|c| c[1].to_string());
    let status = STATUS
        .captures(&html)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string());
    (owner, status)
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .expect("static reqwest client")
    })
}

/// Ask Cap once for a recording's transcript. Err is a failure to reach Cap
/// or to read its answer, worded for "No transcript: <error>."
async fn fetch(video_id: &str) -> Result<Transcript, String> {
    if let Some(text) = CACHE.get(video_id) {
        return Ok(Transcript::Ready(text.clone()));
    }
    let unreachable = |e: reqwest::Error| format!("Cap could not be reached ({e})");
    let page = client()
        .get(format!("https://cap.so/s/{video_id}"))
        .send()
        .await
        .map_err(unreachable)?;
    // Only a 404 means the video is gone; any other failure (a 5xx, a 429
    // rate limit, a bot challenge) is passing, so the AI is told to retry.
    let (owner, status) = if page.status() == reqwest::StatusCode::NOT_FOUND {
        (None, None)
    } else if !page.status().is_success() {
        return Err(format!("Cap answered {}", page.status()));
    } else {
        parse_share_page(&page.text().await.map_err(unreachable)?)
    };
    let Some(owner) = owner else {
        return Ok(Transcript::Unavailable(
            "the video is private, password-protected or deleted".into(),
        ));
    };
    match status.as_deref() {
        Some("COMPLETE") => {}
        Some("NO_AUDIO") => return Ok(Transcript::Unavailable("the video has no audio".into())),
        Some("SKIPPED") => {
            return Ok(Transcript::Unavailable(
                "Cap skipped transcribing it".into(),
            ))
        }
        Some("ERROR") => {
            return Ok(Transcript::Unavailable(
                "Cap failed to transcribe it".into(),
            ))
        }
        _ => return Ok(Transcript::Pending),
    }
    let vtt = client()
        .get(format!(
            "https://v.cap.so/{owner}/{video_id}/transcription.vtt"
        ))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(unreachable)?
        .text()
        .await
        .map_err(unreachable)?;
    let text = vtt_to_text(&vtt);
    if text.is_empty() {
        // COMPLETE means Cap heard speech (silence is NO_AUDIO), so nothing
        // parsed means Cap changed its VTT format.
        tracing::error!("No cues parsed from Cap's VTT for {video_id}");
        return Err("its transcript file could not be read".into());
    }
    CACHE.insert(video_id.to_string(), text.clone());
    Ok(Transcript::Ready(text))
}

/// The `read` block for the Cap links in `text` (the file's accepted view),
/// or None when it has none.
pub async fn cap_transcripts_block(text: &str) -> Option<String> {
    let ids = video_ids(text);
    if ids.is_empty() {
        return None;
    }
    let results = futures::future::join_all(ids.iter().map(|id| fetch(id))).await;
    Some(render_block(text, &ids, &results))
}

/// Lines (1-based, as in the cat -n listing) on which a video's link appears.
fn link_lines(text: &str, video_id: &str) -> Vec<usize> {
    text.lines()
        .enumerate()
        .filter(|(_, line)| SHARE_LINK.captures_iter(line).any(|c| &c[1] == video_id))
        .map(|(i, _)| i + 1)
        .collect()
}

fn render_block(text: &str, ids: &[String], results: &[Result<Transcript, String>]) -> String {
    let mut out = String::from(BLOCK_START);
    for (id, result) in ids.iter().zip(results) {
        let lines = link_lines(text, id)
            .iter()
            .map(|n| n.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        let label = if lines.contains(',') { "lines" } else { "line" };
        out.push_str(&format!(
            "\n\n[Cap] https://cap.so/s/{id} ({label} {lines})"
        ));
        match result {
            Ok(Transcript::Ready(t)) => {
                out.push('\n');
                out.push_str(t);
            }
            Ok(Transcript::Pending) => out.push_str(
                ": no transcript yet — Cap is still transcribing it. Read this file again in a few minutes.",
            ),
            Ok(Transcript::Unavailable(why)) => {
                out.push_str(&format!(": no transcript — {why}."))
            }
            Err(e) => out.push_str(&format!(
                ": no transcript — {e}. Read this file again later."
            )),
        }
    }
    out.push_str("\n\n");
    out.push_str(BLOCK_END);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const VTT: &str = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nHey folks,\n\n2\n00:00:05.000 --> 00:00:06.000\na quick update.\n\n3\n00:00:09.000 --> 00:00:10.500\nNext  topic\nhere.\n";

    #[test]
    fn vtt_breaks_paragraphs_only_after_a_sentence() {
        // The 3s pause after "Hey folks," is mid-sentence, so it stays one line.
        assert_eq!(
            vtt_to_text(VTT),
            "Hey folks, a quick update.\n\nNext topic here."
        );
    }

    #[test]
    fn vtt_reads_hourless_times_tags_and_empty_cues() {
        let vtt = "WEBVTT\n\nNOTE made by hand\n\n00:01.000 --> 00:02.000 align:start\n<v Luke>Hi <b>all</b>.</v>\n\n00:02.500 --> 00:03.000\n\n01:00:03.000 --> 01:00:04.000\r\nBye Luke.\r\n";
        assert_eq!(vtt_to_text(vtt), "Hi all.\n\nBye Luc.");
    }

    #[test]
    fn video_ids_dedupe_and_ignore_other_links() {
        let text = "[Watch](https://cap.so/s/abc123) https://example.com/s/zzz\nsee https://www.cap.so/s/abc123?recordingStopped=1 and http://cap.so/s/X9";
        assert_eq!(video_ids(text), vec!["abc123", "X9"]);
    }

    fn share_page(status: Option<&str>, owner: Option<&str>) -> String {
        let mut row = serde_json::json!({ "transcriptionStatus": status });
        if let Some(o) = owner {
            row["owner"] = serde_json::json!({ "id": o, "name": "Luc" });
        }
        let escaped = row.to_string().replace('"', "\\\"");
        format!("<script>self.__next_f.push([1,\"{escaped}\"])</script>")
    }

    #[test]
    fn share_page_gives_owner_and_status() {
        assert_eq!(
            parse_share_page(&share_page(Some("COMPLETE"), Some("own1"))),
            (Some("own1".into()), Some("COMPLETE".into()))
        );
        assert_eq!(
            parse_share_page(&share_page(None, Some("own1"))),
            (Some("own1".into()), None)
        );
        assert_eq!(parse_share_page(&share_page(None, None)), (None, None));
    }

    #[test]
    fn block_labels_each_link_with_its_lines_and_outcome() {
        let text = "intro https://cap.so/s/aaa\nnone here\n[w](https://cap.so/s/bbb) again https://cap.so/s/aaa\nhttps://cap.so/s/ccc https://cap.so/s/ddd";
        let ids = video_ids(text);
        let results = vec![
            Ok(Transcript::Ready("Hello there.".into())),
            Ok(Transcript::Pending),
            Ok(Transcript::Unavailable("the video has no audio".into())),
            Err("Cap answered 503".into()),
        ];
        assert_eq!(
            render_block(text, &ids, &results),
            format!(
                "{BLOCK_START}\n\n\
                 [Cap] https://cap.so/s/aaa (lines 1, 3)\nHello there.\n\n\
                 [Cap] https://cap.so/s/bbb (line 3): no transcript yet — Cap is still transcribing it. Read this file again in a few minutes.\n\n\
                 [Cap] https://cap.so/s/ccc (line 4): no transcript — the video has no audio.\n\n\
                 [Cap] https://cap.so/s/ddd (line 4): no transcript — Cap answered 503. Read this file again later.\n\n\
                 {BLOCK_END}"
            )
        );
    }

    #[tokio::test]
    async fn no_block_without_cap_links() {
        assert_eq!(
            cap_transcripts_block("just text https://youtu.be/x").await,
            None
        );
    }
}

#[cfg(test)]
mod live_tests {
    /// Reads a real, public Cap recording. Run by hand when Cap changes:
    /// `cargo test -p relay cap_transcripts::live -- --ignored`
    #[tokio::test]
    #[ignore = "network"]
    async fn live_cap_recording_has_a_transcript() {
        let block = super::cap_transcripts_block("https://cap.so/s/nkw7hd9yy2jgsgq")
            .await
            .unwrap();
        assert!(block.contains("weekly review"), "got: {block}");
    }
}
