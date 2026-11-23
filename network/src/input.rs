//! Controller state; Lightyear owns its tick assignment and transport history.
use bevy_ecs::entity::{EntityMapper, MapEntities};
use bevy_reflect::Reflect;
use serde::{Deserialize, Serialize};

pub const STALE_TICKS: u32 = 9;

#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize, Serialize, Reflect)]
pub struct Input {
    pub buttons: u16,
    pub axes: u32,
    pub analog: bool,
}

/// Epoch fences delayed input from a previous battle, independently of native ticks.
#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize, Serialize, Reflect)]
pub struct ControllerCommand {
    pub epoch: u32,
    pub input: Input,
}
impl MapEntities for ControllerCommand {
    fn map_entities<M: EntityMapper>(&mut self, _: &mut M) {}
}
impl MapEntities for Input {
    fn map_entities<M: EntityMapper>(&mut self, _: &mut M) {}
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Rejection {
    Late,
    Future,
    Epoch,
}
