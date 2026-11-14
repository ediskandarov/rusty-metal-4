use super::super::control::reap_closed_links;
use bevy_app::{App, PostUpdate};
use bevy_ecs::prelude::*;
use lightyear::prelude::*;

#[test]
fn closed_links_are_reaped_without_deleting_persistent_controllers() {
    let mut app = App::new();
    app.add_systems(PostUpdate, reap_closed_links);
    let server = app.world_mut().spawn_empty().id();
    let closed = app
        .world_mut()
        .spawn((
            LinkOf { server },
            Unlinked {
                reason: UnlinkReason::ByPeer("test close".into()),
            },
        ))
        .id();
    let child = app.world_mut().spawn(ChildOf(closed)).id();
    let controller = app
        .world_mut()
        .spawn(ControlledBy {
            owner: closed,
            lifetime: Lifetime::Persistent,
        })
        .id();
    let pending = app
        .world_mut()
        .spawn((
            LinkOf { server },
            Unlinked {
                reason: UnlinkReason::Initial,
            },
        ))
        .id();
    let connected = app.world_mut().spawn((LinkOf { server }, Linked)).id();
    assert!(app.world().get::<ControlledSend>(controller).is_some());
    app.update();
    assert!(app.world().get_entity(closed).is_err());
    assert!(app.world().get_entity(child).is_err());
    for entity in [server, controller, pending, connected] {
        assert!(app.world().get_entity(entity).is_ok());
    }
    assert!(app.world().get::<ControlledBy>(controller).is_none());
    assert!(app.world().get::<ControlledSend>(controller).is_none());
}
