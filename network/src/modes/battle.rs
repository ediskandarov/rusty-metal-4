use crate::protocol::{Message, RoundState};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BattleProgress {
    Playing,
    RoundOver,
    Completed,
    TransitionRequested,
}

impl BattleProgress {
    pub fn from_state(state: &RoundState) -> Self {
        if state.completion.reasons != 0 {
            Self::Completed
        } else if state.next_mode != 0 {
            Self::TransitionRequested
        } else if state.round_finished {
            Self::RoundOver
        } else {
            Self::Playing
        }
    }

    pub fn stops_simulation(self) -> bool {
        matches!(self, Self::Completed | Self::TransitionRequested)
    }
}

pub fn final_message(state: &RoundState) -> Option<Message> {
    match BattleProgress::from_state(state) {
        BattleProgress::Completed => Some(Message::Finished {
            state: state.clone(),
        }),
        BattleProgress::TransitionRequested => Some(Message::Error {
            message: TRANSITION_MESSAGE.into(),
        }),
        BattleProgress::Playing | BattleProgress::RoundOver => None,
    }
}

pub const TRANSITION_MESSAGE: &str =
    "The engine requested a transition before a match result was available.";
