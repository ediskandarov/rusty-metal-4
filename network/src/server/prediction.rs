use super::ControllerState;
use lightyear::prelude::input::native::{ActionState, NativeBuffer, NativeStateSequence};
use lightyear::prelude::*;
use tm4_network::{input::Input, protocol as game_protocol, protocol::MAX_PLAYERS};

const START_LEAD_TICKS: i32 = 12;
const MAX_START_LEAD_TICKS: i32 = 180;
const MAX_START_ATTEMPTS: u8 = 5;
struct ClockOffer {
    anchor: Tick,
    sent: Tick,
    votes: [Option<Tick>; MAX_PLAYERS],
}

#[derive(Debug, PartialEq)]
pub(super) enum PredictionStart {
    Waiting,
    Offer(Tick),
    Commit(Tick),
    Unavailable,
}

#[derive(Default)]
pub(super) struct AcceptedTimeline {
    pub(super) anchor: Option<Tick>,
    offer: Option<ClockOffer>,
    attempts: u8,
    pub(super) accepted: [NativeBuffer<Input>; MAX_PLAYERS],
}

impl AcceptedTimeline {
    pub(super) fn vote(&mut self, slot: usize, anchor: Tick, tick: Tick) {
        if let Some(offer) = &mut self.offer
            && offer.anchor == anchor
            && offer.votes[slot].is_none()
        {
            offer.votes[slot] = Some(tick);
        }
    }

    pub(super) fn negotiate(&mut self, now: Tick, slots: &[usize]) -> PredictionStart {
        let lead = if let Some(offer) = &self.offer {
            let votes: Vec<_> = slots.iter().map(|slot| offer.votes[*slot]).collect();
            if votes.iter().any(Option::is_none) {
                return PredictionStart::Waiting;
            }
            let round_trip = (now - offer.sent).max(1);
            let latest =
                votes.iter().flatten().fold(
                    now,
                    |latest, &tick| {
                        if tick - latest > 0 { tick } else { latest }
                    },
                );
            // Allow a full measured exchange for final delivery, plus room for
            // each browser's prediction clock to advance while the vote travels.
            let runway = 2 * round_trip + 2;
            if offer.anchor - latest >= runway {
                let anchor = offer.anchor;
                self.anchor = Some(anchor);
                self.offer = None;
                return PredictionStart::Commit(anchor);
            }
            (latest - now).saturating_add(3 * round_trip + START_LEAD_TICKS)
        } else {
            START_LEAD_TICKS
        };
        if self.attempts >= MAX_START_ATTEMPTS || lead > MAX_START_LEAD_TICKS {
            return PredictionStart::Unavailable;
        }
        let anchor = now + lead;
        self.offer = Some(ClockOffer {
            anchor,
            sent: now,
            votes: [None; MAX_PLAYERS],
        });
        self.attempts += 1;
        PredictionStart::Offer(anchor)
    }

    pub(super) fn packet(
        &mut self,
        tick: u32,
        inputs: &[Input],
        controls: &[ControllerState],
        occupied: &[usize],
    ) -> game_protocol::AcceptedInputs {
        use lightyear::input::input_message::{ActionStateSequence, InputTarget, PerTargetData};
        let end = self.anchor.unwrap() + tick as i32 + 1;
        let mut packet = game_protocol::AcceptedInputs::new(end);
        packet.rebroadcast = true;
        for (slot, player) in controls.iter().enumerate() {
            if !occupied.contains(&slot) {
                continue;
            }
            let buffer = &mut self.accepted[slot];
            buffer.set(end, ActionState(inputs[slot]));
            if buffer.len() > usize::from(game_protocol::PREDICTION_DEPTH + 1) {
                buffer.pop(end - u32::from(game_protocol::PREDICTION_DEPTH + 1));
            }
            if let Some(controller) = player.controller {
                packet.inputs.push(PerTargetData {
                    target: InputTarget::Entity(controller),
                    states: NativeStateSequence::build_from_input_buffer(buffer, buffer.len(), end)
                        .expect("accepted history contains a row for every slot"),
                });
            }
        }
        packet
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sparse_clock_quorum_does_not_wait_for_free_slots() {
        let mut timeline = AcceptedTimeline::default();
        let slots = [0, 3, 7];
        let PredictionStart::Offer(anchor) = timeline.negotiate(Tick(100), &slots) else {
            panic!("offer");
        };
        timeline.vote(0, anchor, Tick(101));
        timeline.vote(3, anchor, Tick(101));
        assert_eq!(
            timeline.negotiate(Tick(102), &slots),
            PredictionStart::Waiting
        );
        timeline.vote(7, anchor, Tick(101));
        assert_eq!(
            timeline.negotiate(Tick(102), &slots),
            PredictionStart::Commit(anchor)
        );
    }

    #[test]
    fn a_late_vote_reoffers_before_commit_and_ignores_old_votes() {
        let mut timeline = AcceptedTimeline::default();
        assert_eq!(
            timeline.negotiate(Tick(100), &(0..2).collect::<Vec<_>>()),
            PredictionStart::Offer(Tick(112))
        );
        timeline.vote(0, Tick(112), Tick(104));
        assert_eq!(
            timeline.negotiate(Tick(118), &(0..2).collect::<Vec<_>>()),
            PredictionStart::Waiting
        );
        timeline.vote(1, Tick(112), Tick(123));
        let PredictionStart::Offer(anchor) =
            timeline.negotiate(Tick(120), &(0..2).collect::<Vec<_>>())
        else {
            panic!("Expired offer was not replaced");
        };
        assert!(timeline.anchor.is_none());
        timeline.vote(0, Tick(112), Tick(124));
        timeline.vote(1, anchor, Tick(126));
        assert_eq!(
            timeline.negotiate(Tick(125), &(0..2).collect::<Vec<_>>()),
            PredictionStart::Waiting
        );
        timeline.vote(0, anchor, Tick(129));
        assert_eq!(
            timeline.negotiate(Tick(127), &(0..2).collect::<Vec<_>>()),
            PredictionStart::Commit(anchor)
        );
        assert_eq!(timeline.anchor, Some(anchor));
    }

    #[test]
    fn an_unusable_peer_cannot_unbound_the_offer_window() {
        let mut timeline = AcceptedTimeline::default();
        assert_eq!(
            timeline.negotiate(Tick(100), &(0..2).collect::<Vec<_>>()),
            PredictionStart::Offer(Tick(112))
        );
        timeline.vote(0, Tick(112), Tick(104));
        timeline.vote(1, Tick(112), Tick(350));
        assert_eq!(
            timeline.negotiate(Tick(106), &(0..2).collect::<Vec<_>>()),
            PredictionStart::Unavailable
        );
        assert!(timeline.anchor.is_none());
    }
}
