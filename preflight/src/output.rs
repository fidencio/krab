use crate::{probe::Result, Check};
use std::fmt::Write;

pub fn text(architecture: &str, results: &[(Check, Result)]) {
    println!("Architecture: {architecture}");
    for (check, result) in results {
        match result {
            Result::Available => println!("{}: available", check.name()),
            Result::Unavailable(reason) => println!("{}: unavailable ({reason})", check.name()),
            Result::Skipped(reason) => println!("{}: skipped ({reason})", check.name()),
            Result::Error(reason) => eprintln!("{}: error ({reason})", check.name()),
        }
    }
}

pub fn json(architecture: &str, results: &[(Check, Result)]) -> String {
    let mut output = String::from("{\"architecture\":");
    json_string(&mut output, architecture);
    output.push_str(",\"checks\":[");
    for (index, (check, result)) in results.iter().enumerate() {
        if index != 0 {
            output.push(',');
        }
        let (status, reason) = match result {
            Result::Available => ("available", None),
            Result::Unavailable(reason) => ("unavailable", Some(reason.as_str())),
            Result::Skipped(reason) => ("skipped", Some(reason.as_str())),
            Result::Error(reason) => ("error", Some(reason.as_str())),
        };
        output.push_str("{\"check\":");
        json_string(&mut output, check.id());
        output.push_str(",\"status\":");
        json_string(&mut output, status);
        output.push_str(",\"reason\":");
        if let Some(reason) = reason {
            json_string(&mut output, reason);
        } else {
            output.push_str("null");
        }
        output.push('}');
    }
    output.push_str("]}");
    output
}

fn json_string(output: &mut String, value: &str) {
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            control if control <= '\u{001f}' => {
                write!(output, "\\u{:04x}", control as u32).unwrap();
            }
            other => output.push(other),
        }
    }
    output.push('"');
}

#[cfg(test)]
mod tests {
    use super::{json, json_string};
    use crate::{probe::Result, Check};

    #[test]
    fn json_has_stable_fields_for_each_result() {
        let output = json(
            "arm64",
            &[
                (Check::Kvm, Result::Available),
                (Check::Snp, Result::Unavailable("disabled".into())),
                (Check::Tdx, Result::Error("unreadable".into())),
            ],
        );
        assert_eq!(output, "{\"architecture\":\"arm64\",\"checks\":[{\"check\":\"kvm\",\"status\":\"available\",\"reason\":null},{\"check\":\"snp\",\"status\":\"unavailable\",\"reason\":\"disabled\"},{\"check\":\"tdx\",\"status\":\"error\",\"reason\":\"unreadable\"}]}");
    }

    #[test]
    fn json_escapes_control_characters_and_preserves_unicode() {
        let mut output = String::new();
        json_string(&mut output, "quote \" slash \\ newline\n tab\t nul\0 é");
        assert_eq!(
            output,
            "\"quote \\\" slash \\\\ newline\\n tab\\t nul\\u0000 é\""
        );
    }

    #[test]
    fn json_includes_skipped_checks() {
        let output = json(
            "s390x",
            &[(
                Check::Gpu,
                Result::Skipped("unsupported architecture".into()),
            )],
        );
        assert_eq!(output, "{\"architecture\":\"s390x\",\"checks\":[{\"check\":\"gpu\",\"status\":\"skipped\",\"reason\":\"unsupported architecture\"}]}");
    }
}
