use crate::input::{ControllerCommand, Input};
use crate::protocol::{ControllerIdentity, Message, PREDICTION_DEPTH};
use bevy_app::{App, FixedPostUpdate, FixedPreUpdate, FixedUpdate, PostUpdate, PreUpdate};
use bevy_ecs::prelude::*;
use bevy_time::{Fixed, Time};
use lightyear::input::client::InputSystems;
use lightyear::prelude::client::InputDelayConfig;
use lightyear::prelude::input::native::{ActionState, InputMarker, NativeBuffer};
use lightyear::prelude::*;
use std::collections::VecDeque;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = tm4LivePrediction)]
    fn retain_live_tick(tick: u32) -> u32;
    #[wasm_bindgen(js_namespace = tm4LivePrediction)]
    fn restore_live_tick(tick: u32) -> bool;
    #[wasm_bindgen(js_namespace = tm4LivePrediction)]
    fn stage_live_input(tick: u32, slot: u8, buttons: u16, axes: u32, analog: bool) -> bool;
    #[wasm_bindgen(js_namespace = tm4LivePrediction)]
    fn step_live_tick(tick: u32) -> bool;
    #[wasm_bindgen(js_namespace = tm4LivePrediction)]
    fn live_digest_section(index: u8) -> u32;
    #[wasm_bindgen(js_namespace = tm4LivePrediction)]
    fn finish_live_replay() -> bool;
}

const HISTORY: usize = PREDICTION_DEPTH as usize + 1;
const VERIFICATION_HISTORY: usize = 2 * PREDICTION_DEPTH as usize + 1;
const MAX_SLOTS: usize = 8;
const MAX_EDGES: usize = 16;
type Digests = [u32; 6];
type VerifiedRow = (u32, Digests, [Input; MAX_SLOTS]);

#[derive(Component, Clone, Copy, Debug, PartialEq)]
pub(crate) struct CheckpointTick(pub(crate) u32);

impl CheckpointTick {
    pub(crate) fn spawn(world: &mut World, anchor: Tick) -> Entity {
        let mut history = PredictionHistory::default();
        history.add_predicted(anchor, Some(Self(0)));
        world
            .spawn((DeterministicPredicted::default(), Self(0), history))
            .id()
    }
}

#[derive(Clone, Copy)]
struct Session {
    epoch: u32,
    slots: u8,
    local_slot: u8,
    anchor: Tick,
}

#[derive(Resource, Default)]
pub struct LivePrediction {
    pub expected_slots: Option<u8>,
    session: Option<Session>,
    resume_warmup: bool,
    pending_resume_rollback: Option<Tick>,
    held: Input,
    edges: VecDeque<Input>,
    checksums: VecDeque<VerifiedRow>,
    confirmations: VecDeque<Message>,
    received_mismatch: bool,
    restoring: bool,
    sequence: u32,
    head: u32,
    confirmed: u32,
    rollbacks: u32,
    window_waits: u32,
    replayed: u32,
    depth: u32,
    bytes: u32,
    peak_bytes: u32,
    error: Option<String>,
}

impl LivePrediction {
    pub fn diagnostics(&self, wait: &PredictionWindowWait) -> serde_json::Value {
        serde_json::json!({
            "head": self.head,
            "confirmed": self.confirmed,
            "rollbacks": self.rollbacks,
            "windowWaits": self.window_waits,
            "waitingForInput": wait.is_waiting(),
            "acceptedDepth": wait.prediction_depth(),
            "replayed": self.replayed,
            "maxDepth": self.depth,
            "historyBytes": self.bytes,
            "peakBytes": self.peak_bytes,
            "buttonEdges": self.edges.len(),
        })
    }

    pub fn sample(&mut self, input: Input) -> Result<(), &'static str> {
        if input.buttons != self.held.buttons {
            if self.edges.len() == MAX_EDGES {
                return Err("Local prediction button transitions overflowed");
            }
            self.edges.push_back(input);
        }
        self.held = input;
        Ok(())
    }

    pub fn drain_confirmed(world: &mut World, inbox: Vec<Message>) -> Result<Vec<Message>, String> {
        let session = world.resource::<Self>().session;
        let Some(session) = session else {
            return Ok(inbox);
        };
        if let Some(error) = inbox
            .iter()
            .find(|message| matches!(message, Message::Error { .. }))
        {
            return Ok(vec![error.clone()]);
        }
        let frontier = world
            .query::<(&ControllerIdentity, &NativeBuffer<Input>)>()
            .iter(world)
            .filter(|(identity, _)| identity.slot < session.slots)
            .map(|(_, buffer)| buffer.last_remote_tick)
            .collect::<Vec<_>>();
        let mut state = world.resource_mut::<Self>();
        if let Some(error) = &state.error {
            return Err(error.clone());
        }
        let mut ready = Vec::with_capacity(inbox.len());
        for message in inbox {
            if matches!(message, Message::Frame { .. }) {
                if state.confirmations.len() >= HISTORY {
                    return Err(
                        "Authority confirmation exceeded the retained prediction window".into(),
                    );
                }
                state.confirmations.push_back(message);
            } else {
                ready.push(message);
            }
        }
        while let Some(Message::Frame {
            tick,
            state: authority,
            inputs,
            ..
        }) = state.confirmations.front()
        {
            let tick = *tick + 1;
            if tick != state.confirmed + 1 {
                return Err("Authority sent an out-of-order confirmation".into());
            }
            if frontier.len() != usize::from(session.slots)
                || frontier
                    .iter()
                    .any(|end| end.is_none_or(|end| end < session.anchor + tick as i32))
                || tick > state.head
            {
                break;
            }
            let Some((_, local, applied)) =
                state.checksums.iter().find(|(saved, _, _)| *saved == tick)
            else {
                return Err(
                    "Authority confirmation is older than retained simulation history".into(),
                );
            };
            if authority.unsupported.is_some()
                || local[0] != authority.digest
                || local[1..] != authority.sections
                || applied[..usize::from(session.slots)] != inputs[..]
            {
                return Err(format!(
                    "Predicted simulation diverged at confirmed tick {tick}: local {local:?}, authority {} {:?}, applied {:?}, accepted {inputs:?}",
                    authority.digest,
                    authority.sections,
                    &applied[..usize::from(session.slots)],
                ));
            }
            state.confirmed = tick;
            ready.push(state.confirmations.pop_front().unwrap());
        }
        Ok(ready)
    }
}

fn hashes() -> Digests {
    std::array::from_fn(|index| live_digest_section(index as u8))
}

pub fn install(app: &mut App) {
    app.init_resource::<LivePrediction>();
    app.component::<CheckpointTick>().local_rollback();
    app.add_observer(reject_clock_shift);
    app.add_systems(
        FixedPreUpdate,
        write_local.in_set(InputSystems::WriteClientInputs),
    );
    app.add_systems(FixedUpdate, step_world);
    app.add_systems(
        FixedPostUpdate,
        (update_prediction_wait, discard_waiting_overstep).chain(),
    );
    app.add_systems(PostUpdate, update_prediction_wait);
    app.add_systems(
        PreUpdate,
        (
            request_resume_rollback
                .after(ReplicationSystems::Receive)
                .after(InputSystems::ReceiveInputMessages)
                .before(RollbackSystems::Check),
            observe_mismatch
                .after(InputSystems::ReceiveInputMessages)
                .before(RollbackSystems::Check),
            reject_unhandled
                .after(RollbackSystems::Check)
                .before(RollbackSystems::Prepare),
            restore_world
                .after(RollbackSystems::Prepare)
                .before(RollbackSystems::Rollback),
            end_replay.in_set(RollbackSystems::EndRollback),
        ),
    );
}

fn reject_clock_shift(shift: On<LocalTimelineShift>, mut state: ResMut<LivePrediction>) {
    if shift.delta != 0 && state.session.is_some() {
        state.error = Some("Lightyear resynchronized the live prediction clock".into());
    }
}

pub fn prepare(world: &mut World, slots: u8) {
    world.resource_mut::<LivePrediction>().expected_slots = Some(slots);
    world.insert_resource(InputTimelineConfig::new(
        SyncConfig {
            // A whole-tick jump would move already accepted input out of the C epoch.
            // Lightyear can still adjust fixed-clock speed below this fail-stop threshold.
            max_error_margin: f32::from(PREDICTION_DEPTH) * 4.0,
            ..Default::default()
        },
        InputDelayConfig::no_input_delay(),
    ));
}

pub fn ready(world: &mut World) -> bool {
    let Some(expected) = world.resource::<LivePrediction>().expected_slots else {
        return false;
    };
    if !world.resource::<LocalTimelineSync>().is_synced() {
        return false;
    }
    world
        .query::<(&ControllerIdentity, &NativeBuffer<Input>)>()
        .iter(world)
        .count()
        == usize::from(expected)
        && world
            .query_filtered::<Entity, With<InputMarker<ControllerCommand>>>()
            .iter(world)
            .count()
            == 1
}

pub fn begin(
    world: &mut World,
    anchor: u32,
    epoch: u32,
    slots: u8,
    local_slot: u8,
    checkpoint_depth: u16,
) -> Result<(), &'static str> {
    if world.resource::<LocalTimeline>().tick() >= Tick(anchor) {
        return Err("Prediction start arrived after the native clock anchor");
    }
    start_at(
        world,
        Session {
            epoch,
            slots,
            local_slot,
            anchor: Tick(anchor),
        },
        checkpoint_depth,
        0,
        0,
    )
}

pub fn resume_target(world: &World, anchor: u32, head: u32) -> Result<u32, &'static str> {
    let clock = world.resource::<LocalTimeline>().tick();
    let target = (clock + 2 - Tick(anchor)).max(head as i32);
    if world.resource::<LivePrediction>().session.is_some() || target <= 0 {
        return Err("Invalid resume clock");
    }
    Ok(target as u32)
}

pub fn begin_resume(
    world: &mut World,
    anchor: u32,
    epoch: u32,
    slots: u8,
    local_slot: u8,
    checkpoint_depth: u16,
    head: u32,
    sequence: u32,
) -> Result<(), &'static str> {
    let anchor = Tick(anchor);
    let boundary = anchor + head as i32;
    let clock = world.resource::<LocalTimeline>().tick();
    let depth = clock - boundary;
    if depth < 0 || depth > i32::from(PREDICTION_DEPTH) {
        return Err("The native reconnect clock fell outside the handoff window");
    }
    start_at(
        world,
        Session {
            epoch,
            slots,
            local_slot,
            anchor,
        },
        checkpoint_depth,
        head,
        sequence,
    )?;
    if depth != 0 {
        let mut state = world.resource_mut::<LivePrediction>();
        state.resume_warmup = true;
        state.pending_resume_rollback = Some(boundary);
    }
    Ok(())
}

fn start_at(
    world: &mut World,
    session: Session,
    checkpoint_depth: u16,
    head: u32,
    sequence: u32,
) -> Result<(), &'static str> {
    if !ready(world)
        || world.resource::<LivePrediction>().session.is_some()
        || world.resource::<LivePrediction>().expected_slots != Some(session.slots)
        || !(2..=8).contains(&session.slots)
        || session.local_slot >= session.slots
        || checkpoint_depth != PREDICTION_DEPTH
    {
        return Err("Invalid prediction start");
    }
    let boundary = session.anchor + head as i32;
    let mut present = [false; MAX_SLOTS];
    for (identity, mut buffer) in world
        .query::<(&ControllerIdentity, &mut NativeBuffer<Input>)>()
        .iter_mut(world)
    {
        let slot = usize::from(identity.slot);
        if slot >= usize::from(session.slots) || present[slot] {
            return Err("Invalid native controller assignment");
        }
        present[slot] = true;
        if buffer.last_remote_tick.is_none_or(|tick| tick < boundary) {
            buffer.set(boundary, ActionState(Input::default()));
            buffer.last_remote_tick = Some(boundary);
        }
    }
    if present[..usize::from(session.slots)].contains(&false) {
        return Err("A native controller slot was not replicated before play");
    }
    let bytes = retain_live_tick(head);
    if bytes == 0 {
        return Err("The game could not checkpoint the rendered match");
    }
    let mut manager = PredictionManager::default();
    manager.input_rollback_floor = Some(boundary);
    manager.rollback_policy = RollbackPolicy {
        state: RollbackMode::Disabled,
        input: RollbackMode::Check,
        max_rollback_ticks: PREDICTION_DEPTH,
    };
    world.insert_resource(manager);
    let mut history = PredictionHistory::default();
    history.add_predicted(boundary, Some(CheckpointTick(head)));
    world.spawn((
        DeterministicPredicted {
            // The imported world existed at the checkpoint's tick even when
            // this ECS entity was created later on the synchronized timeline.
            skip_despawn: head != 0,
            ..Default::default()
        },
        CheckpointTick(head),
        history,
    ));
    let mut state = world.resource_mut::<LivePrediction>();
    state.session = Some(session);
    state.sequence = sequence;
    state.head = head;
    state.confirmed = head;
    state
        .checksums
        .push_back((head, hashes(), [Input::default(); MAX_SLOTS]));
    state.bytes = bytes;
    state.peak_bytes = bytes;
    Ok(())
}

fn write_local(
    mut state: ResMut<LivePrediction>,
    timeline: SyncedLocalTimeline,
    manager: Option<Res<PredictionManager>>,
    mut local: Single<&mut ActionState<ControllerCommand>, With<InputMarker<ControllerCommand>>>,
) {
    let Some(session) = state.session else {
        return;
    };
    let native_tick = timeline.tick();
    if native_tick <= session.anchor
        || manager.is_some_and(|manager| manager.is_rollback())
        || state.error.is_some()
    {
        return;
    }
    if timeline.input_delay() != 0 {
        state.error = Some(
            "Network timing requires more input delay than this prediction mode supports".into(),
        );
        return;
    }
    let input = state.edges.pop_front().unwrap_or(state.held);
    state.sequence += 1;
    local.0 = ControllerCommand {
        epoch: session.epoch,
        sequence: state.sequence,
        tick: (native_tick - session.anchor - 1) as u32,
        input,
    };
}

fn step_world(
    mut state: ResMut<LivePrediction>,
    timeline: SyncedLocalTimeline,
    mut checkpoint: Single<&mut CheckpointTick>,
    local: Single<&ActionState<ControllerCommand>, With<InputMarker<ControllerCommand>>>,
    mut slots: Query<(
        &ControllerIdentity,
        &ActionState<Input>,
        &mut NativeBuffer<Input>,
    )>,
) {
    let Some(session) = state.session else {
        return;
    };
    let native_tick = timeline.tick();
    if native_tick <= session.anchor || state.error.is_some() {
        return;
    }
    let tick = checkpoint.0;
    if native_tick != session.anchor + tick as i32 + 1 {
        state.error = Some("Lightyear shifted beyond the C simulation timeline".into());
        return;
    }
    let mut inputs = [None; MAX_SLOTS];
    for (identity, accepted, mut buffer) in &mut slots {
        let slot = identity.slot;
        if slot >= session.slots || inputs[slot as usize].is_some() {
            state.error = Some("Invalid native controller slot".into());
            return;
        }
        let frontier = buffer.last_remote_tick.unwrap_or(session.anchor);
        if native_tick - frontier > i32::from(PREDICTION_DEPTH) {
            state.error = Some(format!(
                "Accepted inputs fell outside the retained prediction window (slot {slot}, native {}, accepted through {}, buffered {:?}..{:?}, C head {tick}, confirmed {})",
                native_tick.0,
                frontier.0,
                buffer.start_tick.map(|t| t.0),
                buffer.end_tick().map(|t| t.0),
                state.confirmed,
            ));
            return;
        }
        let input = if native_tick <= frontier {
            let Some(input) = buffer.get(native_tick) else {
                state.error = Some(format!(
                    "The native accepted input history has a missing tick (slot {slot}, {native_tick:?}, start {:?}, frontier {frontier:?})",
                    buffer.start_tick
                ));
                return;
            };
            input.0
        } else if slot != session.local_slot || state.resume_warmup {
            accepted.0
        } else {
            if local.0.tick != tick || local.0.epoch != session.epoch {
                state.error =
                    Some("Lightyear lost the predicted local input for a fixed tick".into());
                return;
            }
            local.0.input
        };
        // Match against the actual C input, including the remote hold chosen by Lightyear.
        if native_tick > frontier {
            buffer.set(native_tick, ActionState(input));
        }
        inputs[slot as usize] = Some(input);
    }
    let inputs = &inputs[..usize::from(session.slots)];
    if inputs.iter().any(Option::is_none) {
        state.error = Some("A native controller slot was not replicated before play".into());
        return;
    }
    let mut applied = [Input::default(); MAX_SLOTS];
    for (slot, input) in inputs.iter().flatten().enumerate() {
        applied[slot] = *input;
        if !stage_live_input(tick, slot as u8, input.buttons, input.axes, input.analog) {
            state.error = Some("The game refused a Lightyear controller sample".into());
            return;
        }
    }
    if !step_live_tick(tick) {
        state.error = Some("The game refused a Lightyear fixed tick".into());
        return;
    }
    let bytes = retain_live_tick(tick + 1);
    if bytes == 0 {
        state.error = Some("The game could not retain the predicted world".into());
        return;
    }
    checkpoint.0 = tick + 1;
    state.head = checkpoint.0;
    state.bytes = bytes;
    state.peak_bytes = state.peak_bytes.max(bytes);
    if state.checksums.len() == VERIFICATION_HISTORY {
        state.checksums.pop_front();
    }
    state.checksums.push_back((checkpoint.0, hashes(), applied));
    if state.restoring {
        state.replayed += 1;
    }
}

fn update_prediction_wait(
    mut state: ResMut<LivePrediction>,
    timeline: Res<LocalTimeline>,
    slots: Query<(&ControllerIdentity, &NativeBuffer<Input>)>,
    mut wait: ResMut<PredictionWindowWait>,
) {
    let tick = timeline.tick();
    let Some(session) = state.session else {
        return;
    };
    if tick <= session.anchor || state.restoring || state.error.is_some() {
        return;
    }
    let mut count = 0;
    let frontier = slots
        .iter()
        .filter(|(identity, _)| identity.slot < session.slots)
        .map(|(_, buffer)| {
            count += 1;
            buffer.last_remote_tick.unwrap_or(session.anchor)
        })
        .reduce(|a, b| if a - b <= 0 { a } else { b });
    let frontier = if count == session.slots {
        frontier
    } else {
        Some(session.anchor)
    };
    if wait.update(tick, frontier, PREDICTION_DEPTH) && wait.is_waiting() {
        state.window_waits += 1;
    }
}

fn discard_waiting_overstep(
    state: Res<LivePrediction>,
    wait: Res<PredictionWindowWait>,
    mut fixed: ResMut<Time<Fixed>>,
) {
    // Lightyear applies the wait to the next frame. Cancel additional fixed
    // ticks already accumulated by this frame before any can cross the bound.
    if wait.is_waiting() && !state.restoring {
        let overstep = fixed.overstep();
        fixed.discard_overstep(overstep);
    }
}

fn request_resume_rollback(
    mut state: ResMut<LivePrediction>,
    mut metadata: ResMut<StateRollbackMetadata>,
) {
    if let Some(tick) = state.pending_resume_rollback.take() {
        metadata.request_forced_rollback(tick);
    }
}

fn observe_mismatch(mut state: ResMut<LivePrediction>, manager: Option<Res<PredictionManager>>) {
    state.received_mismatch = state.session.is_some()
        && manager.is_some_and(|manager| manager.earliest_mismatch_input.has_mismatches());
}

fn reject_unhandled(mut state: ResMut<LivePrediction>, manager: Option<Res<PredictionManager>>) {
    if state.received_mismatch && manager.is_some_and(|manager| !manager.is_rollback()) {
        state.error =
            Some("Lightyear refused a correction outside the retained prediction window".into());
    }
}

fn restore_world(
    mut state: ResMut<LivePrediction>,
    timeline: Res<LocalTimeline>,
    manager: Option<Res<PredictionManager>>,
    checkpoint: Single<&CheckpointTick>,
) {
    let (Some(session), Some(tick), None) = (
        state.session,
        manager.and_then(|manager| manager.get_rollback_start_tick()),
        &state.error,
    ) else {
        return;
    };
    if tick != session.anchor + checkpoint.0 as i32
        || checkpoint.0 < state.confirmed
        || !restore_live_tick(checkpoint.0)
    {
        state.error = Some("The game refused Lightyear's restored checkpoint".into());
        return;
    }
    state.rollbacks += 1;
    state.depth = state.depth.max((timeline.tick() - tick).max(0) as u32);
    state.restoring = true;
    state.checksums.retain(|(tick, _, _)| *tick <= checkpoint.0);
}

fn end_replay(mut state: ResMut<LivePrediction>) {
    state.resume_warmup = false;
    if std::mem::take(&mut state.restoring) && !finish_live_replay() && state.error.is_none() {
        state.error = Some("The game refused to end Lightyear rollback".into());
    }
}
