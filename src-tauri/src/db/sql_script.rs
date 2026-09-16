#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Normal,
    SingleQuote,
    DoubleQuote,
    Backtick,
    LineComment,
    BlockComment,
}

pub fn split_mysql_script(script: &str, mona_stmt_sep: &str) -> Result<Vec<String>, String> {
    let chars: Vec<char> = script.chars().collect();
    let separator: Vec<char> = mona_stmt_sep.chars().collect();
    let mut statements = Vec::new();
    let mut statement = String::new();
    let mut state = State::Normal;
    let mut line_prefix_only = true;
    let mut line = 1;
    let mut index = 0;
    let mut contains_sql = false;

    while index < chars.len() {
        match state {
            State::Normal => {
                if chars[index] == '\n' {
                    statement.push(chars[index]);
                    line += 1;
                    line_prefix_only = true;
                    index += 1;
                    continue;
                }

                if line_prefix_only
                    && !separator.is_empty()
                    && starts_with(&chars, index, &separator)
                {
                    push_statement(&mut statements, &mut statement, &mut contains_sql);
                    while index < chars.len() && chars[index] != '\n' {
                        index += 1;
                    }
                    continue;
                }

                if line_prefix_only && starts_with_keyword(&chars, index, "DELIMITER") {
                    return Err(format!(
                        "DELIMITER directives are not supported (line {})",
                        line
                    ));
                }

                match chars[index] {
                    '\'' => {
                        statement.push(chars[index]);
                        contains_sql = true;
                        state = State::SingleQuote;
                        line_prefix_only = false;
                        index += 1;
                    }
                    '"' => {
                        statement.push(chars[index]);
                        contains_sql = true;
                        state = State::DoubleQuote;
                        line_prefix_only = false;
                        index += 1;
                    }
                    '`' => {
                        statement.push(chars[index]);
                        contains_sql = true;
                        state = State::Backtick;
                        line_prefix_only = false;
                        index += 1;
                    }
                    ';' => {
                        push_statement(&mut statements, &mut statement, &mut contains_sql);
                        line_prefix_only = false;
                        index += 1;
                    }
                    '-' if chars.get(index + 1) == Some(&'-')
                        && chars
                            .get(index + 2)
                            .map_or(true, |character| character.is_whitespace()) =>
                    {
                        statement.push('-');
                        statement.push('-');
                        state = State::LineComment;
                        line_prefix_only = false;
                        index += 2;
                    }
                    '#' => {
                        statement.push('#');
                        state = State::LineComment;
                        line_prefix_only = false;
                        index += 1;
                    }
                    '/' if chars.get(index + 1) == Some(&'*') => {
                        statement.push('/');
                        statement.push('*');
                        if chars.get(index + 2) == Some(&'!') {
                            contains_sql = true;
                        }
                        state = State::BlockComment;
                        index += 2;
                    }
                    character => {
                        statement.push(character);
                        if !character.is_whitespace() {
                            contains_sql = true;
                            line_prefix_only = false;
                        }
                        index += 1;
                    }
                }
            }
            State::SingleQuote | State::DoubleQuote | State::Backtick => {
                let quote = match state {
                    State::SingleQuote => '\'',
                    State::DoubleQuote => '"',
                    State::Backtick => '`',
                    _ => unreachable!(),
                };
                let character = chars[index];
                statement.push(character);

                if character == '\\' {
                    if let Some(escaped) = chars.get(index + 1).copied() {
                        statement.push(escaped);
                        if escaped == '\n' {
                            line += 1;
                        }
                        index += 2;
                        continue;
                    }
                }

                if character == quote {
                    if chars.get(index + 1) == Some(&quote) {
                        statement.push(quote);
                        index += 2;
                        continue;
                    }
                    state = State::Normal;
                }
                if character == '\n' {
                    line += 1;
                }
                index += 1;
            }
            State::LineComment => {
                let character = chars[index];
                statement.push(character);
                if character == '\n' {
                    state = State::Normal;
                    line += 1;
                    line_prefix_only = true;
                }
                index += 1;
            }
            State::BlockComment => {
                if chars[index] == '*' && chars.get(index + 1) == Some(&'/') {
                    statement.push('*');
                    statement.push('/');
                    state = State::Normal;
                    index += 2;
                    continue;
                }
                let character = chars[index];
                statement.push(character);
                if character == '\n' {
                    line += 1;
                }
                index += 1;
            }
        }
    }

    match state {
        State::SingleQuote | State::DoubleQuote | State::Backtick => {
            return Err(format!("unterminated quoted value (line {})", line));
        }
        State::BlockComment => {
            return Err(format!("unterminated block comment (line {})", line));
        }
        State::Normal | State::LineComment => {}
    }

    push_statement(&mut statements, &mut statement, &mut contains_sql);
    Ok(statements)
}

fn push_statement(
    statements: &mut Vec<String>,
    statement: &mut String,
    contains_sql: &mut bool,
) {
    let trimmed = statement.trim();
    if *contains_sql && !trimmed.is_empty() {
        statements.push(trimmed.to_string());
    }
    statement.clear();
    *contains_sql = false;
}

fn starts_with(chars: &[char], index: usize, expected: &[char]) -> bool {
    chars
        .get(index..index.saturating_add(expected.len()))
        .is_some_and(|candidate| candidate == expected)
}

fn starts_with_keyword(chars: &[char], index: usize, keyword: &str) -> bool {
    let keyword_chars: Vec<char> = keyword.chars().collect();
    let Some(candidate) = chars.get(index..index.saturating_add(keyword_chars.len())) else {
        return false;
    };
    if !candidate
        .iter()
        .zip(keyword_chars.iter())
        .all(|(actual, expected)| actual.eq_ignore_ascii_case(expected))
    {
        return false;
    }
    chars
        .get(index + keyword_chars.len())
        .map_or(true, |character| character.is_whitespace())
}

#[cfg(test)]
mod tests {
    use super::split_mysql_script;

    const MONA_STMT_SEP: &str = "-- !MONA_SEP!";

    #[test]
    fn splits_semicolons_outside_quotes_and_comments() {
        let script = r#"
            INSERT INTO `items` VALUES ('a;b', "c;d", `e;f`); -- comment ;
            /* block ; comment */ SELECT 2;
            # hash ; comment
            SELECT 3;
        "#;

        let statements = split_mysql_script(script, MONA_STMT_SEP).expect("valid script");

        assert_eq!(statements.len(), 3);
        assert!(statements[0].contains("'a;b'"));
        assert!(statements[1].contains("SELECT 2"));
        assert!(statements[2].contains("SELECT 3"));
    }

    #[test]
    fn mona_separator_ends_a_statement_without_a_semicolon() {
        let script = "SET FOREIGN_KEY_CHECKS=0\n-- !MONA_SEP!\nINSERT INTO items VALUES (1)\n-- !MONA_SEP!\n";

        let statements = split_mysql_script(script, MONA_STMT_SEP).expect("valid script");

        assert_eq!(statements, vec![
            "SET FOREIGN_KEY_CHECKS=0",
            "INSERT INTO items VALUES (1)",
        ]);
    }

    #[test]
    fn rejects_delimiter_directives_before_execution() {
        let script = "delimiter $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\nDELIMITER ;";

        let error = split_mysql_script(script, MONA_STMT_SEP).expect_err("delimiter is unsupported");

        assert!(error.contains("DELIMITER"));
    }

    #[test]
    fn ignores_delimiter_text_inside_comments_and_strings() {
        let script = "-- DELIMITER $$\nSELECT 'DELIMITER $$';";

        let statements = split_mysql_script(script, MONA_STMT_SEP).expect("valid script");

        assert_eq!(statements.len(), 1);
    }

    #[test]
    fn preserves_multiline_text_that_looks_like_a_comment() {
        let script = "INSERT INTO notes VALUES ('line one\n-- text\nline three');";

        let statements = split_mysql_script(script, MONA_STMT_SEP).expect("valid script");

        assert_eq!(statements.len(), 1);
        assert!(statements[0].contains("\n-- text\n"));
    }

    #[test]
    fn drops_comment_only_tail_but_keeps_executable_comments() {
        let statements = split_mysql_script("SELECT 1; -- trailing ;\n", MONA_STMT_SEP)
            .expect("valid script");
        assert_eq!(statements, vec!["SELECT 1"]);

        let statements = split_mysql_script("/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE */;", MONA_STMT_SEP)
            .expect("valid script");
        assert_eq!(statements.len(), 1);
        assert!(statements[0].starts_with("/*!40101"));
    }

    #[test]
    fn rejects_unterminated_quotes_and_block_comments() {
        let quote_error = split_mysql_script("SELECT 'unterminated", MONA_STMT_SEP)
            .expect_err("unterminated quote must fail");
        assert!(quote_error.contains("quoted"));

        let comment_error = split_mysql_script("SELECT 1 /* unterminated", MONA_STMT_SEP)
            .expect_err("unterminated comment must fail");
        assert!(comment_error.contains("block comment"));
    }
}
