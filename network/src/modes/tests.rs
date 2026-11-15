use super::*;
use crate::protocol::{Compatibility, PROTOCOL_VERSION, ParticipantId};

fn session(mode: MatchMode) -> SessionStart {
    let cars = vec!["Orbital".into(), "Orbital".into()];
    let parameters = mode.session_parameters(
        FfaLimits::default(),
        &["Pizza Boy".into(), "Orbital".into()],
        &cars,
    );
    SessionStart {
        bots: vec![],
        mode,
        limits: parameters.limits,
        respawn_delay_ticks: parameters.respawn_delay_ticks,
        capacity: MAX_PLAYERS,
        slots: vec![0, 1],
        participants: vec![ParticipantId(1), ParticipantId(2)],
        world: "Construction Yard".into(),
        cars,
        model_pool: parameters.model_pool,
        compatibility: Compatibility {
            protocol: PROTOCOL_VERSION,
            build: "build".into(),
            content: "content".into(),
        },
        seed: 12345,
        epoch: 1,
        portable: true,
    }
}

#[test]
fn mode_parameters_preserve_session_fields_and_model_order() {
    let ffa = session(MatchMode::Ffa);
    let tournament = session(MatchMode::Tournament);
    for start in [&ffa, &tournament] {
        assert!(start.valid_slots());
        let json = serde_json::to_value(start).unwrap();
        assert_eq!(json.as_object().unwrap().len(), 14);
        assert_eq!(json["capacity"], 8);
        assert_eq!(json["slots"], serde_json::json!([0, 1]));
        assert_eq!(json["cars"], serde_json::json!(["Orbital", "Orbital"]));
        let restored: SessionStart = serde_json::from_value(json.clone()).unwrap();
        assert!(restored.valid_slots());
        assert_eq!(serde_json::to_value(restored).unwrap(), json);
    }
    let json = serde_json::to_value(ffa).unwrap();
    assert_eq!(json["mode"], "ffa");
    assert_eq!(
        json["limits"],
        serde_json::json!({"timeLimitTicks": 27000, "fragLimit": 20})
    );
    assert_eq!(json["respawnDelayTicks"], ffa::respawn_delay_ticks());
    assert_eq!(
        json["modelPool"],
        serde_json::json!(["Orbital", "Pizza Boy"])
    );
    let json = serde_json::to_value(tournament).unwrap();
    assert_eq!(json["mode"], "tournament");
    assert_eq!(
        json["limits"],
        serde_json::json!({"timeLimitTicks": 0, "fragLimit": 0})
    );
    assert_eq!(json["respawnDelayTicks"], 0);
    assert_eq!(json["modelPool"], serde_json::json!(["Orbital"]));
}

#[test]
fn session_validation_keeps_mode_rules_and_common_slot_guards() {
    let ffa = session(MatchMode::Ffa);
    let tournament = session(MatchMode::Tournament);
    for mode in [MatchMode::Ffa, MatchMode::Tournament] {
        let mut invalid = session(mode);
        invalid.participants[1] = invalid.participants[0];
        assert!(!invalid.valid_slots());
    }
    let mut sparse = ffa.clone();
    sparse.slots = vec![0, 7];
    sparse.bots = vec![7];
    assert!(sparse.valid_slots());
    sparse.mode = MatchMode::Tournament;
    sparse.limits = tournament.limits;
    sparse.respawn_delay_ticks = 0;
    assert!(!sparse.valid_slots());
    for delay in [0, 3601] {
        let mut invalid = ffa.clone();
        invalid.respawn_delay_ticks = delay;
        assert!(!invalid.valid_slots());
    }
    for field in ["world", "bots", "limits", "respawnDelayTicks"] {
        let mut json = serde_json::to_value(&tournament).unwrap();
        json[field] = match field {
            "world" => serde_json::json!("Road Rage"),
            "bots" => serde_json::json!([1]),
            "limits" => serde_json::to_value(FfaLimits::default()).unwrap(),
            _ => serde_json::json!(1),
        };
        assert!(
            !serde_json::from_value::<SessionStart>(json)
                .unwrap()
                .valid_slots(),
            "{field}"
        );
    }
}
