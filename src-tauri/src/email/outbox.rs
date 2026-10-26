use super::{decrypt_password, get_imap_credentials, EmailState};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::time::Duration;

const UNKNOWN: &str = "发送结果尚未确认，请先检查已发送邮件，勿直接重复发送。";

pub(super) fn claim(conn: &Connection, id: &str) -> Result<bool, String> {
    conn.execute(
        "UPDATE email_outbox SET status = 'unknown', error = ?1 WHERE id = ?2 AND status = 'pending'",
        params![UNKNOWN, id],
    )
    .map(|count| count == 1)
    .map_err(|e| format!("保存定时邮件发送记录失败: {e}"))
}

pub(super) fn cancel(conn: &Connection, id: &str) -> Result<(), String> {
    let changed = conn.execute("DELETE FROM email_outbox WHERE id=?1 AND status='pending'", params![id])
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM email_outbox WHERE id=?1)", params![id], |r| r.get(0)).map_err(|e| e.to_string())?;
        if exists { return Err("邮件已开始发送，不能取消，请先核对发送结果。".into()); }
    }
    Ok(())
}

fn finish(conn: &Connection, id: &str, status: &str, error: Option<&str>) -> Result<(), String> {
    conn.execute(
        "UPDATE email_outbox SET status = ?1, error = ?2 WHERE id = ?3 AND status = 'unknown'",
        params![status, error, id],
    )
    .map_err(|e| format!("保存发送结果失败；{UNKNOWN} ({e})"))?;
    Ok(())
}

fn addresses(value: &str) -> Result<Vec<String>, String> {
    if value.trim().is_empty() {
        return Ok(Vec::new());
    }
    let parsed = mailparse::addrparse(value).map_err(|_| "收件人地址格式不正确".to_string())?;
    let mut result = Vec::new();
    for address in parsed.iter() {
        match address {
            mailparse::MailAddr::Single(info) => result.push(info.addr.clone()),
            mailparse::MailAddr::Group(group) => {
                result.extend(group.addrs.iter().map(|info| info.addr.clone()));
            }
        }
    }
    Ok(result)
}

pub(super) async fn process(state: &EmailState, service_url: &str) -> Result<(u32, bool), String> {
    let due: Vec<(String, String, Value)> = {
        let conn = state.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, account_id, to_addresses, cc_addresses, bcc_addresses, subject,
                    body_text, body_html, in_reply_to, attachments_json
             FROM email_outbox WHERE status = 'pending' AND scheduled_at <= ?1 ORDER BY scheduled_at, id",
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![chrono::Utc::now().to_rfc3339()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, json!({
                "to": row.get::<_, String>(2)?, "cc": row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                "bcc": row.get::<_, Option<String>>(4)?.unwrap_or_default(), "subject": row.get::<_, String>(5)?,
                "bodyText": row.get::<_, String>(6)?, "bodyHtml": row.get::<_, Option<String>>(7)?.unwrap_or_default(),
                "inReplyTo": row.get::<_, Option<String>>(8)?, "attachmentsJson": row.get::<_, Option<String>>(9)?,
            })))
        }).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };
    let client = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(90))
        .build().map_err(|e| e.to_string())?;
    let mut sent = 0;
    let mut needs_attention = false;
    for (id, account_id, mut request) in due {
        let prepared = (|| -> Result<(), String> {
            let conn = state.conn()?;
            let account = get_imap_credentials(&conn, &account_id)?;
            request["to"] = json!(addresses(request["to"].as_str().unwrap_or_default())?);
            request["cc"] = json!(addresses(request["cc"].as_str().unwrap_or_default())?);
            request["bcc"] = json!(addresses(request["bcc"].as_str().unwrap_or_default())?);
            request["attachments"] = match request["attachmentsJson"].as_str().filter(|s| !s.is_empty()) {
                Some(value) => serde_json::from_str(value).map_err(|_| "附件记录无法读取".to_string())?,
                None => json!([]),
            };
            request.as_object_mut().unwrap().remove("attachmentsJson");
            request["accountId"] = json!(account_id);
            request["smtpHost"] = json!(account.smtp_host);
            request["smtpPort"] = json!(account.smtp_port);
            request["smtpUsername"] = json!(account.smtp_username);
            request["smtpPassword"] = json!(decrypt_password(&account.smtp_password)?);
            request["useSsl"] = json!(account.smtp_use_ssl);
            request["useTls"] = json!(!account.smtp_use_ssl);
            request["fromAddress"] = json!(account.from_address);
            request["fromName"] = json!(account.from_name);
            request["imapHost"] = json!(account.imap_host);
            request["imapPort"] = json!(account.imap_port);
            request["imapUsername"] = json!(account.imap_username);
            request["imapPassword"] = json!(decrypt_password(&account.imap_password)?);
            request["imapUseSsl"] = json!(account.imap_use_ssl);
            Ok(())
        })();
        let conn = state.conn()?;
        if let Err(error) = prepared {
            let updated = conn.execute("UPDATE email_outbox SET status = 'failed', error = ?1 WHERE id = ?2 AND status = 'pending'",
                params![error, id]).map_err(|e| e.to_string())?;
            needs_attention |= updated > 0;
            continue;
        }
        // A durable claim precedes SMTP; concurrent calls and restarts never resend an unknown attempt.
        if !claim(&conn, &id)? { continue; }
        drop(conn);
        let outcome = client.post(format!("{}/email/send", service_url.trim_end_matches('/')))
            .json(&request).send().await;
        match outcome {
            Ok(response) if response.status().is_success() => {
                finish(&state.conn()?, &id, "sent", None)?;
                sent += 1;
            }
            Ok(response) => {
                let result: Value = response.json().await.unwrap_or_default();
                let definite_failure = result["sendState"] == "failed";
                finish(&state.conn()?, &id, if definite_failure { "failed" } else { "unknown" },
                    Some(if definite_failure { "定时邮件未能发送，请检查收件人和邮箱设置。" } else { UNKNOWN }))?;
                needs_attention = true;
            }
            Err(_) => {
                finish(&state.conn()?, &id, "unknown", Some(UNKNOWN))?;
                needs_attention = true;
            }
        }
    }
    Ok((sent, needs_attention))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claimed_or_interrupted_attempt_is_never_claimed_again() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE email_outbox(id TEXT PRIMARY KEY, status TEXT, error TEXT);
                            INSERT INTO email_outbox VALUES('one', 'pending', NULL);").unwrap();
        assert!(claim(&conn, "one").unwrap());
        assert!(!claim(&conn, "one").unwrap());
        assert!(cancel(&conn, "one").is_err());
        assert_eq!(conn.query_row("SELECT status FROM email_outbox", [], |r| r.get::<_, String>(0)).unwrap(), "unknown");
        finish(&conn, "one", "sent", None).unwrap();
        assert!(!claim(&conn, "one").unwrap());
    }

    #[test]
    fn cancelling_pending_mail_prevents_a_later_send_claim() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE email_outbox(id TEXT PRIMARY KEY, status TEXT, error TEXT);
                            INSERT INTO email_outbox VALUES('one', 'pending', NULL);").unwrap();
        cancel(&conn, "one").unwrap();
        assert!(!claim(&conn, "one").unwrap());
    }

    #[test]
    fn quoted_display_names_do_not_become_smtp_recipients() {
        assert_eq!(addresses("\"Doe, Jane\" <jane@example.test>, John Smith <john@example.test>").unwrap(),
            vec!["jane@example.test", "john@example.test"]);
    }
}
