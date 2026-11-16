use std::{error::Error, path::PathBuf};
use tm4_network::protocol::MAX_PLAYERS;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Command {
    Precompile { input: PathBuf, output: PathBuf },
    InspectJournal(PathBuf),
    Server(ServerOptions),
}
#[derive(Debug, PartialEq, Eq)]
pub(super) struct ServerOptions {
    pub players: usize,
    pub serve: bool,
    pub bots: Vec<String>,
}

impl Command {
    pub fn parse(
        mut args: impl Iterator<Item = String>,
        embedded: bool,
    ) -> Result<Self, Box<dyn Error>> {
        let mut first = args
            .next()
            .unwrap_or_else(|| if embedded { "--serve" } else { "2" }.into());
        if first == "--precompile-simulation" {
            let input = args.next().ok_or("Expected source Wasm path")?;
            let output = args.next().ok_or("Expected compiled module path")?;
            if args.next().is_some() {
                return Err("Unexpected precompile argument".into());
            }
            return Ok(Command::Precompile {
                input: input.into(),
                output: output.into(),
            });
        }
        let serve = first == "--serve";
        if serve {
            first = args.next().unwrap_or_else(|| "2".into());
        }
        if first == "--inspect-journal" {
            let path = args.next().ok_or("Expected the journal path")?;
            return Ok(Command::InspectJournal(path.into()));
        }
        let count: usize = first.parse()?;
        if !(1..=MAX_PLAYERS).contains(&count) {
            return Err("Expected a player count from 1 to 8".into());
        }
        let mut command_bots = Vec::new();
        while let Some(flag) = args.next() {
            if flag != "--bot" || serve {
                return Err("Use --bot MODEL only with a standalone match".into());
            }
            command_bots.push(
                args.next()
                    .ok_or("Expected an original-AI car model after --bot")?,
            );
        }
        if count + command_bots.len() > MAX_PLAYERS {
            return Err("Humans and bots must fit within eight gameplay slots".into());
        }

        Ok(Self::Server(ServerOptions {
            players: count,
            serve,
            bots: command_bots,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn parse(args: &[&str], embedded: bool) -> Result<Command, Box<dyn Error>> {
        Command::parse(args.iter().map(|arg| (*arg).to_owned()), embedded)
    }

    #[test]
    fn launch_defaults_and_explicit_options_are_preserved() {
        for (args, embedded, players, serve, bots) in [
            (vec![], false, 2, false, vec![]),
            (vec![], true, 2, true, vec![]),
            (vec!["--serve"], false, 2, true, vec![]),
            (vec!["--serve", "6"], false, 6, true, vec![]),
            (
                vec!["1", "--bot", "Orbital", "--bot", "Pizza Boy"],
                false,
                1,
                false,
                vec!["Orbital", "Pizza Boy"],
            ),
        ] {
            assert_eq!(
                parse(&args, embedded).unwrap(),
                Command::Server(ServerOptions {
                    players,
                    serve,
                    bots: bots.into_iter().map(String::from).collect(),
                })
            );
        }
    }

    #[test]
    fn invalid_capacity_and_bot_arguments_are_rejected_before_startup() {
        for args in [
            vec!["0"],
            vec!["9"],
            vec!["two"],
            vec!["2", "--unknown"],
            vec!["1", "--bot"],
            vec!["--serve", "1", "--bot", "Orbital"],
            vec!["8", "--bot", "Orbital"],
        ] {
            assert!(parse(&args, false).is_err(), "{args:?}");
        }
    }

    #[test]
    fn utility_commands_are_parsed_without_starting_a_server() {
        assert_eq!(
            parse(&["--inspect-journal", "match.tm4j"], true).unwrap(),
            Command::InspectJournal("match.tm4j".into())
        );
        assert_eq!(
            parse(
                &["--precompile-simulation", "source.wasm", "target.cwasm"],
                true
            )
            .unwrap(),
            Command::Precompile {
                input: "source.wasm".into(),
                output: "target.cwasm".into()
            }
        );
        for args in [
            vec!["--inspect-journal"],
            vec!["--precompile-simulation"],
            vec!["--precompile-simulation", "source.wasm"],
            vec![
                "--precompile-simulation",
                "source.wasm",
                "target.cwasm",
                "extra",
            ],
        ] {
            assert!(parse(&args, false).is_err(), "{args:?}");
        }
    }
}
