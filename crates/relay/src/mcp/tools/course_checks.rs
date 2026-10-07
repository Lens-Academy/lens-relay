//! Course checks: writing checks on the course text an agent just changed,
//! returned in the same `edit`/`create` result so the agent fixes a problem on
//! the spot instead of a reviewer finding it later.
//!
//! After an edit or create of a `.md` file in the course folder, the file's
//! all-suggestions-accepted text (the view `read` numbers, so the platform's
//! line numbers are the agent's) before and after the call goes to
//! lens-platform's `POST /api/content/course-checks` as
//! `{"path", "content", "previous_content"}`, with `previous_content` null for
//! a new file. `path` is the relay path with its folder name,
//! "Lens Edu/modules/x.md" (`validate_content` sends the same file as
//! "modules/x.md"); the platform decides from it which files are course text.
//! It checks only the paragraphs that changed and answers with a `summary`,
//! empty unless a check clearly failed, changed paragraphs went unchecked, or
//! the file has open findings from earlier edits or reviews.
//!
//! [`after_write`] writes the end of a Markdown `edit` or `create` result.
//! After an edit it also runs `validate_content`'s brief check of the file, at
//! the same time as the course checks, so the result waits for the slower of
//! the two, never for their sum.
//!
//! The checks are off unless this relay's `ENABLE_COURSE_CHECKS` is true and
//! it has `ADHOC_VALIDATION_SECRET` (both read by `Platform::from_env`); the
//! platform has a switch of the same name, so each side can be turned on
//! separately. Articles are never sent: they are other authors' words, which
//! the platform does not check, and the largest files in the folder.
//!
//! The checks are advisory. Anything short of a summary appends nothing: a
//! timeout, an error status, a bad reply, an answer that comes after the
//! reply went. They keep their own record of the platform's health
//! (`validate_content::note_outcome`): a failure is logged when it starts and
//! when it ends, and after a timeout or a connection error they leave the
//! platform alone for a while. The record is theirs alone, so a failing course
//! check never pauses the validator check; they do leave the platform alone
//! while the validator check does. So they never fail an edit, and never hold
//! a reply more than [`COURSE_CHECKS_GRACE`] past its validator check, or
//! [`COURSE_CHECKS_CAP`] when it has none.

use super::create_doc::is_lens_edu_articles_path;
use super::validate_content::{self, CheckError, Platform, View};
use crate::server::Server;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::task::JoinHandle;

const COURSE_CHECKS_PATH: &str = "/api/content/course-checks";
/// This kind of check in the platform's health record and in the log.
const CHECKS: &str = "course checks";
/// The platform gives the checks a 4 s budget; this bounds the request, which
/// runs on after a reply stops waiting for it.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
/// How long an `edit` reply waits for the course checks once its validator
/// check has ended (answered, skipped or failed). The course checks took a
/// median of about 470 ms and a p90 of about 630 ms when measured, and the
/// validator check usually takes longer, so they have answered by then.
const COURSE_CHECKS_GRACE: Duration = Duration::from_millis(500);
/// How long a reply with no validator check (a `create`) waits for them.
const COURSE_CHECKS_CAP: Duration = Duration::from_millis(1500);

/// The part of the platform's answer the relay uses.
#[derive(Deserialize)]
struct Reply {
    summary: String,
    skipped: Option<String>,
}

/// The text that ends a successful `edit` or `create` result for the file at
/// `path` (its relay path, folder name first): the lines of
/// `validate_content`'s brief check, then the course checks' summary after a
/// blank line; "" when neither has anything to say.
///
/// `before` and `after` are the file's all-suggestions-accepted text before
/// and after the call; `before` is `None` when the call created the file.
/// `check` is the view and the time budget of the brief check, which only
/// `edit` runs. Both checks run at once, and the reply waits for the course
/// checks only [`COURSE_CHECKS_GRACE`] past the brief check, or
/// [`COURSE_CHECKS_CAP`] when there is none.
pub async fn after_write(
    server: &Arc<Server>,
    path: &str,
    before: Option<&str>,
    after: &str,
    check: Option<(View, Duration)>,
    platform: Option<&Platform>,
) -> String {
    let course = start(path, before, after, platform);
    let check = match check {
        Some((view, budget)) => {
            validate_content::edit_check(server, path, view, platform, budget).await
        }
        None => None,
    };
    let wait = match check {
        Some(_) => COURSE_CHECKS_GRACE,
        None => COURSE_CHECKS_CAP,
    };
    let summary = match course {
        Some(course) => wait_for(course, wait, path).await,
        None => None,
    };
    let mut end = String::new();
    if let Some(lines) = check {
        end.push('\n');
        end.push_str(&lines);
    }
    if let Some(summary) = summary {
        end.push_str("\n\n");
        end.push_str(&summary);
    }
    end
}

/// Start the course checks of the file at `path` on a task of their own, which
/// ends in the summary or `None`; `None` when they are off, do not read the
/// file, or leave the platform alone. The request outlives a reply that stops
/// waiting for it, so its outcome still reaches the health record, and the
/// platform still gets to record its answer for the file's next edit.
fn start(
    path: &str,
    before: Option<&str>,
    after: &str,
    platform: Option<&Platform>,
) -> Option<JoinHandle<Option<String>>> {
    let platform = platform.filter(|platform| platform.course_checks)?;
    let course_markdown =
        validate_content::content_path(path).is_some_and(|rel| rel.ends_with(".md"));
    if !course_markdown || is_lens_edu_articles_path(path) {
        return None;
    }
    let busy = validate_content::busy_until(platform, validate_content::EDIT_CHECKS)
        .or_else(|| validate_content::busy_until(platform, CHECKS));
    if let Some(until) = busy {
        tracing::debug!(
            "course checks: none for {}: the checks leave the platform alone until {}",
            path,
            until
        );
        return None;
    }
    let body = json!({ "path": path, "content": after, "previous_content": before });
    let (platform, path) = (platform.clone(), path.to_string());
    Some(tokio::spawn(async move {
        let outcome = ask(&platform, body).await;
        validate_content::note_outcome(&platform, CHECKS, outcome.as_ref().err());
        let reply = outcome.ok()?;
        if reply.summary.trim().is_empty() {
            tracing::debug!(
                "course checks: nothing to report for {} (skipped: {:?})",
                path,
                reply.skipped
            );
            return None;
        }
        Some(reply.summary)
    }))
}

/// The summary of the course checks `course` of the file at `path`, if they
/// end within `wait`.
async fn wait_for(
    course: JoinHandle<Option<String>>,
    wait: Duration,
    path: &str,
) -> Option<String> {
    match tokio::time::timeout(wait, course).await {
        Ok(summary) => summary.ok().flatten(),
        Err(_) => {
            tracing::debug!(
                "course checks: the reply for {} went without them after {} ms; \
                 the platform still records their answer",
                path,
                wait.as_millis()
            );
            None
        }
    }
}

/// One request, sent as `validate_content` sends its own: gzipped JSON with
/// the platform's key.
async fn ask(platform: &Platform, body: Value) -> Result<Reply, CheckError> {
    let (status, _, text) =
        validate_content::post_json(platform, COURSE_CHECKS_PATH, body, REQUEST_TIMEOUT).await?;
    if !(200..300).contains(&status) {
        let said: String = text.chars().take(200).collect();
        let reason = format!("the platform answered {}: {}", status, said);
        return Err(CheckError::Failed(reason));
    }
    serde_json::from_str(&text).map_err(|e| CheckError::Failed(format!("unreadable answer: {}", e)))
}

/// Whether a value of `ENABLE_COURSE_CHECKS` turns the checks on: 1, true,
/// yes or on, the values lens-platform accepts for its switch.
pub fn switched_on(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

// The tests never read the environment, so a secret in a developer's shell
// cannot send test text to a real platform: each test passes a mock platform.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tools::test_helpers::*;
    use crate::mcp::tools::validate_content::{CONTENT_FOLDER, EDIT_CHECK_BUDGET};
    use crate::mcp::tools::{create_doc, critic_markup, edit};
    use serde_json::Value;

    const PATH: &str = "Lens Edu/modules/x.md";
    /// The platform's summary for one clear failure, as it writes it.
    const SUMMARY: &str = "Course checks: 1 likely writing problem in paragraphs you changed.\n\
        False either-or. Name the other options too (a middle position, both, neither), \
        or say why only these two are possible.\n\
        - line 1: \"Either we regulate compute or we lose control of AI for good.\"\n\
        Fix these, or leave them if you are sure they are wrong.";
    /// `validate_content`'s line for [`clean_check`] after a direct edit.
    const CLEAN_LINE: &str =
        "Check (approved view, commit 4d37677 + 0 relay files): this file has no issues.";

    /// A course-checks answer shaped like the platform's.
    fn answer(summary: &str, skipped: Option<&str>) -> MockReply {
        MockReply::ok(json!({
            "suite_version": "a1b2c3d4",
            "model": "jev-1.13.0",
            "checked_paragraphs": 1,
            "cached_paragraphs": 0,
            "unchecked_paragraphs": 0,
            "findings": [],
            "skipped": skipped,
            "summary": summary,
        }))
    }

    /// A validator answer: the edited file has no issues.
    fn clean_check() -> MockReply {
        MockReply::ok(json!({"status": "done", "commit": "4d37677ba",
                             "target": {"content": true, "issues": []}}))
    }

    /// A mock platform whose validator finds nothing and whose course checks
    /// answer `answers`, and the config that reaches it with the course
    /// checks on.
    async fn mock(answers: Vec<MockReply>) -> (MockPlatform, Platform) {
        let mock = mock_platform_with(vec![clean_check()], answers).await;
        let platform = switched_on_for(&mock);
        (mock, platform)
    }

    fn switched_on_for(mock: &MockPlatform) -> Platform {
        Platform {
            course_checks: true,
            ..mock.platform()
        }
    }

    /// The bodies of the course-checks requests the platform got.
    fn asked(mock: &MockPlatform) -> Vec<Value> {
        let requests = mock.requests().into_iter();
        let course = requests.filter(|r| r.path == COURSE_CHECKS_PATH);
        course.map(|r| r.body).collect()
    }

    /// The end of a `create` result for `path` with the text "Some text.".
    async fn create_end(server: &Arc<Server>, path: &str, platform: Option<&Platform>) -> String {
        after_write(server, path, None, "Some text.", None, platform).await
    }

    /// A server with the course folder and the file [`PATH`] holding `text`,
    /// written by the agent, and a session that has read it.
    async fn course_file(text: &str) -> (Arc<Server>, String, String) {
        let server = build_blob_test_server_with_folder().await;
        rename_folder0(&server, CONTENT_FOLDER);
        let sid = setup_session_no_reads(&server);
        let args = json!({"file_path": PATH, "content": text});
        create_doc::execute_checked(&server, &sid, &args, None)
            .await
            .unwrap();
        let doc_id = server.doc_resolver().resolve_path(PATH).unwrap().doc_id;
        let sid = setup_session_with_read(&server, &doc_id);
        (server, sid, doc_id)
    }

    fn edit_args(old: &str, new: &str) -> Value {
        json!({"file_path": PATH, "old_string": old, "new_string": new})
    }

    /// The result of an `edit` checked against `platform`.
    async fn edited(server: &Arc<Server>, sid: &str, args: Value, platform: &Platform) -> String {
        edit::execute_checked(server, sid, &args, Some(platform), EDIT_CHECK_BUDGET)
            .await
            .unwrap()
    }

    fn accepted_text(server: &Arc<Server>, doc_id: &str) -> String {
        critic_markup::accepted_view(&critic_markup::parse(&read_doc_content(server, doc_id)))
    }

    // Prevents: a platform round trip on every edit of files that are not
    // course text (pages, data, articles, other folders, a look-alike folder
    // name), or while the checks are switched off; an article upload can pass
    // half a megabyte, twice.
    #[tokio::test]
    async fn only_course_markdown_is_sent_and_only_when_switched_on() {
        let server = build_test_server_in(CONTENT_FOLDER, &[]).await;
        let (mock, platform) = mock(vec![answer(SUMMARY, None)]).await;
        for path in [
            "Lens Edu/modules/page.html",
            "Lens Edu/timestamps.json",
            "Lens Edu/articles/x.md",
            "Lens/modules/x.md",
            "Lens Edu archive/x.md",
        ] {
            assert_eq!(
                create_end(&server, path, Some(&platform)).await,
                "",
                "{path}"
            );
        }
        let off = mock.platform();
        assert_eq!(create_end(&server, PATH, Some(&off)).await, "");
        assert_eq!(create_end(&server, PATH, None).await, "");
        assert!(mock.requests().is_empty(), "nothing may be sent");

        assert_eq!(
            create_end(&server, PATH, Some(&platform)).await,
            format!("\n\n{SUMMARY}")
        );
        assert_eq!(asked(&mock).len(), 1);
    }

    // Prevents: a relay calling the platform on every course edit before
    // anyone switched the checks on, as the secret alone once did.
    #[test]
    fn the_switch_reads_like_the_platforms() {
        for value in ["1", "true", " TRUE ", "yes", "on"] {
            assert!(switched_on(value), "{value}");
        }
        for value in ["", "0", "false", "off", "enabled"] {
            assert!(!switched_on(value), "{value}");
        }
    }

    // Prevents: the platform getting the wrong texts, no secret, or a body it
    // cannot read (it reads gzipped JSON, as /check does), or the summary
    // running into the result's last line.
    #[tokio::test]
    async fn sends_path_both_texts_and_secret_and_appends_the_summary() {
        let server = build_test_server_in(CONTENT_FOLDER, &[]).await;
        let (mock, platform) = mock(vec![answer(SUMMARY, None)]).await;
        let end = after_write(
            &server,
            PATH,
            Some("Old text."),
            "New text.",
            None,
            Some(&platform),
        )
        .await;
        assert_eq!(end, format!("\n\n{SUMMARY}"));
        let requests = mock.requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].path, COURSE_CHECKS_PATH);
        assert_eq!(requests[0].key, "sek");
        assert_eq!(requests[0].encoding, "gzip");
        assert_eq!(
            requests[0].body,
            json!({"path": PATH, "content": "New text.", "previous_content": "Old text."})
        );
    }

    // Prevents: dropping the clear failures the platform found before Jev
    // went away. The platform's summary, not its `skipped`, decides.
    #[tokio::test]
    async fn appends_a_partial_answers_summary() {
        let server = build_test_server_in(CONTENT_FOLDER, &[]).await;
        let (_mock, platform) = mock(vec![answer(SUMMARY, Some("timeout"))]).await;
        assert_eq!(
            create_end(&server, PATH, Some(&platform)).await,
            format!("\n\n{SUMMARY}")
        );
    }

    // Prevents: anything but a summary (a clean result, a skip, an error,
    // a reply in another shape) reaching the agent as if it were findings.
    #[tokio::test]
    async fn appends_nothing_unless_the_platform_has_a_summary() {
        let server = build_test_server_in(CONTENT_FOLDER, &[]).await;
        let cases = [
            ("clean", answer("", None)),
            ("off", answer("", Some("not_configured"))),
            ("blank", answer(" \n", Some("jev_unavailable"))),
            (
                "401",
                MockReply::status(401).body(json!({"detail": "Invalid validation key"})),
            ),
            ("404", MockReply::status(404)),
            (
                "500",
                MockReply::status(500).body(json!("Internal Server Error")),
            ),
            ("not an object", MockReply::ok(json!("not json"))),
            ("no summary", MockReply::ok(json!({"findings": []}))),
        ];
        for (case, reply) in cases {
            let (mock, platform) = mock(vec![reply]).await;
            assert_eq!(
                create_end(&server, PATH, Some(&platform)).await,
                "",
                "{case}"
            );
            assert_eq!(asked(&mock).len(), 1, "{case}");
        }
    }

    /// A course-checks answer that never comes.
    fn hung() -> MockReply {
        answer(SUMMARY, None).delay(Duration::from_secs(600))
    }

    /// Let the course-checks request the platform holds run out its own
    /// timeout: paused, the clock jumps to it. Paused before the request has
    /// crossed the socket, it could jump before the platform holds it.
    async fn time_out_the_held_request(mock: &MockPlatform) {
        assert_eq!(asked(mock).len(), 1, "the platform holds the request");
        tokio::time::pause();
        tokio::time::sleep(REQUEST_TIMEOUT).await;
        tokio::time::resume();
    }

    /// The requests the validator check sent.
    fn validator_checks(mock: &MockPlatform) -> usize {
        let requests = mock.requests().into_iter();
        requests.filter(|r| r.path == "/api/content/check").count()
    }

    // Prevents: a hung course-checks endpoint holding an edit until the
    // request's 5 s timeout, though the validator check had answered long
    // before, and that timeout skipping the validator check of the edits
    // after it ("the platform is busy"), as both once did.
    #[tokio::test]
    async fn a_hung_course_check_holds_an_edit_for_the_grace_only() {
        let ms = Duration::from_millis;
        let (server, sid, _) = course_file("One.").await;
        let mock = mock_platform_with(vec![clean_check().delay(ms(300))], vec![hung()]).await;
        let platform = switched_on_for(&mock);

        let started = std::time::Instant::now();
        let reply = edited(&server, &sid, edit_args("One.", "One. Two."), &platform).await;
        let waited = started.elapsed();
        println!("validator 300 ms, course checks hung: edit took {waited:?}");
        assert!(reply.ends_with(&format!("\n{CLEAN_LINE}")), "{reply}");
        let grace_ended = ms(300) + COURSE_CHECKS_GRACE;
        assert!(
            waited >= grace_ended && waited < grace_ended + ms(300),
            "waited {waited:?}"
        );

        // The request runs on to its own timeout, which pauses the course
        // checks alone.
        time_out_the_held_request(&mock).await;
        assert!(validate_content::busy_until(&platform, CHECKS).is_some());
        assert_eq!(
            validate_content::busy_until(&platform, validate_content::EDIT_CHECKS),
            None
        );

        let started = std::time::Instant::now();
        let reply = edited(&server, &sid, edit_args("Two.", "Two. Three."), &platform).await;
        let waited = started.elapsed();
        println!("validator 300 ms, course checks paused: edit took {waited:?}");
        assert!(reply.ends_with(&format!("\n{CLEAN_LINE}")), "{reply}");
        assert!(waited >= ms(300) && waited < ms(500), "waited {waited:?}");
        assert_eq!(validator_checks(&mock), 2, "both edits checked");
        assert_eq!(asked(&mock).len(), 1, "the course checks leave it alone");
    }

    // Prevents: a hung course-checks endpoint holding every create for the
    // request's 5 s, or (with no timeout of its own) for the shared client's
    // 300 s; and the course checks asking it again at once after it timed
    // out.
    #[tokio::test]
    async fn a_hung_course_check_holds_a_create_for_the_cap_then_backs_off() {
        let (server, sid, _) = course_file("One.").await;
        let (mock, platform) = mock(vec![hung()]).await;
        let create = |path: &'static str| {
            let args = json!({"file_path": path, "content": "New."});
            let (server, sid, platform) = (&server, &sid, &platform);
            async move {
                create_doc::execute_checked(server, sid, &args, Some(platform))
                    .await
                    .unwrap()
            }
        };

        let started = std::time::Instant::now();
        let y = "Lens Edu/modules/y.md";
        assert_eq!(create(y).await, format!("Created {y}"));
        let waited = started.elapsed();
        println!("course checks hung: create took {waited:?}");
        // The create's own work adds up to 0.4 s while the whole suite runs;
        // the request's own timeout is 5 s.
        let most = COURSE_CHECKS_CAP + Duration::from_secs(1);
        assert!(
            waited >= COURSE_CHECKS_CAP && waited < most,
            "waited {waited:?}"
        );

        time_out_the_held_request(&mock).await;
        assert!(validate_content::busy_until(&platform, CHECKS).is_some());
        assert_eq!(
            validate_content::busy_until(&platform, validate_content::EDIT_CHECKS),
            None
        );
        let started = std::time::Instant::now();
        let z = "Lens Edu/modules/z.md";
        assert_eq!(create(z).await, format!("Created {z}"));
        let waited = started.elapsed();
        println!("course checks paused: create took {waited:?}");
        assert!(waited < COURSE_CHECKS_CAP, "waited {waited:?}");
        assert_eq!(asked(&mock).len(), 1, "nothing asked while it hangs");
    }

    // Prevents: create skipping the course checks, claiming a previous text
    // for a file that did not exist, or running the validator check, which
    // only edit has.
    #[tokio::test]
    async fn create_result_carries_the_course_checks() {
        let server = build_blob_test_server_with_folder().await;
        rename_folder0(&server, CONTENT_FOLDER);
        let sid = setup_session_no_reads(&server);
        let (mock, platform) = mock(vec![answer(SUMMARY, None)]).await;

        let args = json!({"file_path": PATH, "content": "A new paragraph."});
        let result = create_doc::execute_checked(&server, &sid, &args, Some(&platform))
            .await
            .unwrap();

        assert_eq!(result, format!("Created {PATH}\n\n{SUMMARY}"));
        let requests = mock.requests();
        assert_eq!(requests.len(), 1, "no validator check");
        assert_eq!(
            requests[0].body,
            json!({"path": PATH, "content": "A new paragraph.", "previous_content": null})
        );
    }

    // Prevents: edit sending raw CriticMarkup instead of the accepted text,
    // sending text that does not match the stored document, or sending an
    // edit addressed without ".md" under a path the platform does not
    // recognise; and the summary running into the validator's lines.
    #[tokio::test]
    async fn edit_result_ends_with_the_validator_check_then_the_course_checks() {
        let (server, sid, doc_id) = course_file("Intro paragraph.\n\nSecond paragraph.\n").await;
        let (mock, platform) = mock(vec![answer(SUMMARY, None)]).await;

        // A pending change is checked as if accepted.
        let mut args = edit_args("Second", "Next");
        args["mode"] = json!("suggest");
        assert_eq!(
            edited(&server, &sid, args, &platform).await,
            format!(
                "Made pending changes to {PATH} as requested (replaced 6 characters).\n\
                 Check (drafts view, commit 4d37677 + 0 relay files): this file has no issues.\
                 \n\n{SUMMARY}"
            )
        );
        let body = asked(&mock).pop().unwrap();
        assert_eq!(
            body,
            json!({"path": PATH,
                   "previous_content": "Intro paragraph.\n\nSecond paragraph.\n",
                   "content": "Intro paragraph.\n\nNext paragraph.\n"})
        );
        assert_eq!(body["content"], accepted_text(&server, &doc_id));

        // A direct change, addressed without ".md", the way the resolver
        // allows: sent under the file's full path.
        let mut args = edit_args("Intro paragraph.", "Intro paragraph. Added.");
        args["file_path"] = json!("Lens Edu/modules/x");
        assert_eq!(
            edited(&server, &sid, args, &platform).await,
            format!(
                "Made the changes to Lens Edu/modules/x (inserted 7 characters).\n\
                 {CLEAN_LINE}\n\n{SUMMARY}"
            )
        );
        let body = asked(&mock).pop().unwrap();
        assert_eq!(
            body,
            json!({"path": PATH,
                   "previous_content": "Intro paragraph.\n\nNext paragraph.\n",
                   "content": "Intro paragraph. Added.\n\nNext paragraph.\n"})
        );
        assert_eq!(body["content"], accepted_text(&server, &doc_id));
    }

    // Prevents: an edit waiting for the validator check and then for the
    // course checks: the two run at once, so it waits for the slower one.
    #[tokio::test]
    async fn an_edit_waits_for_the_slower_check_not_for_both() {
        let ms = Duration::from_millis;
        for (check_ms, course_ms) in [(300, 200), (200, 300)] {
            let (server, sid, _) = course_file("Intro.").await;
            let mock = mock_platform_with(
                vec![clean_check().delay(ms(check_ms))],
                vec![answer(SUMMARY, None).delay(ms(course_ms))],
            )
            .await;
            let platform = switched_on_for(&mock);

            let started = std::time::Instant::now();
            let args = edit_args("Intro.", "Intro. More.");
            let reply = edited(&server, &sid, args, &platform).await;
            let waited = started.elapsed();

            assert!(
                reply.ends_with(&format!("\n{CLEAN_LINE}\n\n{SUMMARY}")),
                "{reply}"
            );
            println!("validator {check_ms} ms, course checks {course_ms} ms: edit took {waited:?}");
            // One after the other, the two take 500 ms or more.
            assert!(waited >= ms(300) && waited < ms(500), "waited {waited:?}");
        }
    }

    // Prevents: the course checks adding their own wait to every edit and
    // create for the length of an incident, by asking a platform that edit
    // checks leave alone.
    #[tokio::test]
    async fn the_course_checks_leave_a_busy_platform_alone() {
        let (server, sid, _) = course_file("One.").await;
        let mock = mock_platform_with(
            vec![MockReply::status(429).retry_after(30)],
            vec![answer(SUMMARY, None)],
        )
        .await;
        let platform = switched_on_for(&mock);

        // The edit that finds the platform busy had its course checks
        // answered already: the two run at once.
        let first = edited(&server, &sid, edit_args("One.", "One. Two."), &platform).await;
        assert!(
            first.ends_with(&format!(
                "\nCheck skipped: the platform's check queue is full (429); retry in 30 s. \
                 The edit stands; run validate_content later.\n\n{SUMMARY}"
            )),
            "{first}"
        );
        assert_eq!(mock.requests().len(), 2);

        let second = edited(&server, &sid, edit_args("Two.", "Two. Three."), &platform).await;
        assert!(
            second.contains("\nCheck skipped: the platform is busy (retrying after "),
            "{second}"
        );
        assert!(!second.contains(SUMMARY), "{second}");
        let created = create_doc::execute_checked(
            &server,
            &sid,
            &json!({"file_path": "Lens Edu/modules/y.md", "content": "New."}),
            Some(&platform),
        )
        .await
        .unwrap();
        assert_eq!(created, "Created Lens Edu/modules/y.md");
        assert_eq!(mock.requests().len(), 2, "nothing asked while busy");
    }
}
