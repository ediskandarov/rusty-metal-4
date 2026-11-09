use std::{
    env,
    error::Error,
    net::SocketAddr,
    thread,
    time::{Duration, Instant},
};

use aeronet_io::connection::LocalAddr;
use bevy_app::{App, Update};
use bevy_ecs::prelude::*;
use lightyear_link::{Link, LinkStart, Linked};
use lightyear_websocket::server::{ServerConfig, WebSocketServerIo, WebSocketServerPlugin};
use serde::{Deserialize, Serialize};

const TICK_RATE: u64 = 30;
const MAX_PLAYERS: usize = 8;
const STEP: Duration = Duration::from_nanos(1_000_000_000 / TICK_RATE);

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
struct Input {
    buttons: u16,
    axes: u32,
    analog: bool,
}

#[derive(Deserialize, Serialize)]
struct Score {
    wins: i32,
    losses: i32,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RoundState {
    remaining: u8,
    winner: i8,
    round_finished: bool,
    accepts_continue: bool,
    next_mode: i32,
    digest: u32,
    scores: Vec<Score>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Request {
    Join,
    Authority { token: String },
    Ready,
    Input { sequence: u32, input: Input },
    Completed { tick: u32, state: RoundState },
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Message<'a> {
    Welcome {
        slot: Option<usize>,
    },
    Start {
        players: usize,
        world: u32,
        seed: u32,
    },
    Step {
        tick: u32,
        inputs: &'a [Input],
    },
    Frame {
        tick: u32,
        inputs: &'a [Input],
        state: &'a RoundState,
    },
    Finished,
    Error {
        message: &'static str,
    },
}

#[derive(Default)]
struct Player {
    entity: Option<Entity>,
    ready: bool,
    input: Input,
    sequence: Option<u32>,
}

#[derive(Resource)]
struct Match {
    players: Vec<Player>,
    token: String,
    authority: Option<Entity>,
    authority_ready: bool,
    started: bool,
    ended: bool,
    tick: u32,
    next_step: Instant,
    in_flight: Option<(Vec<Input>, Instant)>,
}

fn send(links: &mut Query<(Entity, &mut Link), With<Linked>>, entity: Entity, message: &Message) {
    if let Ok((_, mut link)) = links.get_mut(entity) {
        link.send(
            serde_json::to_vec(message)
                .expect("message serialization")
                .into(),
        );
    }
}

impl Match {
    fn broadcast(&self, links: &mut Query<(Entity, &mut Link), With<Linked>>, message: &Message) {
        for entity in self.players.iter().filter_map(|player| player.entity) {
            send(links, entity, message);
        }
    }

    fn fail(
        &mut self,
        links: &mut Query<(Entity, &mut Link), With<Linked>>,
        message: &'static str,
    ) {
        self.ended = true;
        let error = Message::Error { message };
        self.broadcast(links, &error);
        if let Some(authority) = self.authority {
            send(links, authority, &error);
        }
        eprintln!("{message}");
    }

    fn request(
        &mut self,
        links: &mut Query<(Entity, &mut Link), With<Linked>>,
        entity: Entity,
        request: Request,
    ) {
        let slot = self
            .players
            .iter()
            .position(|player| player.entity == Some(entity));
        let is_authority = self.authority == Some(entity);
        match request {
            Request::Join if !self.started && !self.ended && slot.is_none() && !is_authority => {
                if let Some(slot) = self
                    .players
                    .iter()
                    .position(|player| player.entity.is_none())
                {
                    self.players[slot].entity = Some(entity);
                    send(links, entity, &Message::Welcome { slot: Some(slot) });
                } else {
                    send(
                        links,
                        entity,
                        &Message::Error {
                            message: "The lobby is full.",
                        },
                    );
                }
            }
            Request::Authority { token }
                if !self.started
                    && self.authority.is_none()
                    && slot.is_none()
                    && token == self.token =>
            {
                self.authority = Some(entity);
                send(links, entity, &Message::Welcome { slot: None });
            }
            Request::Ready if self.started => {
                if is_authority {
                    self.authority_ready = true;
                } else if let Some(slot) = slot {
                    self.players[slot].ready = true;
                }
            }
            Request::Input { sequence, input } if self.started => {
                if let Some(player) = slot.map(|slot| &mut self.players[slot]) {
                    if player.sequence.is_none_or(|last| sequence > last) {
                        player.sequence = Some(sequence);
                        player.input = input;
                    }
                }
            }
            Request::Completed { tick, state }
                if is_authority
                    && tick == self.tick
                    && state.scores.len() == self.players.len() =>
            {
                if let Some((inputs, _)) = self.in_flight.take() {
                    self.broadcast(
                        links,
                        &Message::Frame {
                            tick,
                            inputs: &inputs,
                            state: &state,
                        },
                    );
                    self.tick += 1;
                    self.ended = state.next_mode != 0;
                    if self.ended {
                        send(links, entity, &Message::Finished);
                    }
                }
            }
            _ => send(
                links,
                entity,
                &Message::Error {
                    message: "Unexpected message.",
                },
            ),
        }
    }
}

fn update(mut game: ResMut<Match>, mut links: Query<(Entity, &mut Link), With<Linked>>) {
    for slot in 0..game.players.len() {
        let player = &mut game.players[slot];
        if player.entity.is_some_and(|entity| !links.contains(entity)) {
            *player = Player::default();
            if game.started && !game.ended {
                game.fail(&mut links, "A player disconnected.");
            }
        }
    }
    if game.authority.is_some_and(|entity| !links.contains(entity)) {
        game.authority = None;
        if game.started && !game.ended {
            game.fail(&mut links, "The simulator disconnected.");
        }
    }

    let mut requests = Vec::new();
    for (entity, mut link) in &mut links {
        requests.extend(link.recv.drain().filter_map(|packet| {
            if packet.len() > 1024 {
                return None;
            }
            serde_json::from_slice::<Request>(&packet)
                .ok()
                .map(|request| (entity, request))
        }));
    }
    for (entity, request) in requests {
        game.request(&mut links, entity, request);
    }

    let Some(authority) = game.authority else {
        return;
    };
    if game.ended || game.players.iter().any(|player| player.entity.is_none()) {
        return;
    }
    if !game.started {
        game.started = true;
        let message = Message::Start {
            players: game.players.len(),
            world: 0,
            seed: 12345,
        };
        send(&mut links, authority, &message);
        game.broadcast(&mut links, &message);
    }

    let now = Instant::now();
    if !game.authority_ready || game.players.iter().any(|player| !player.ready) {
        game.next_step = now;
        return;
    }
    if let Some((_, since)) = game.in_flight {
        if now.duration_since(since) > Duration::from_secs(3) {
            game.fail(&mut links, "The simulator did not finish its tick.");
        }
        return;
    }
    if now >= game.next_step {
        let inputs: Vec<_> = game.players.iter().map(|player| player.input).collect();
        send(
            &mut links,
            authority,
            &Message::Step {
                tick: game.tick,
                inputs: &inputs,
            },
        );
        game.in_flight = Some((inputs, now));
        game.next_step = (game.next_step + STEP).max(now);
    }
}

fn main() -> Result<(), Box<dyn Error>> {
    let count: usize = env::args().nth(1).unwrap_or_else(|| "2".into()).parse()?;
    if !(2..=MAX_PLAYERS).contains(&count) {
        return Err("Expected a player count from 2 to 8".into());
    }
    let token = env::var("TM4_AUTHORITY_TOKEN")?;
    if token.len() < 32 {
        return Err("TM4_AUTHORITY_TOKEN must have at least 32 characters".into());
    }
    let addr: SocketAddr = env::var("TM4_MATCH_LISTEN")
        .unwrap_or_else(|_| "127.0.0.1:8122".into())
        .parse()?;

    let mut app = App::new();
    app.add_plugins(WebSocketServerPlugin);
    let entity = app
        .world_mut()
        .spawn((
            LocalAddr(addr),
            WebSocketServerIo {
                config: ServerConfig::builder()
                    .with_bind_address(addr)
                    .with_no_encryption(),
            },
        ))
        .id();
    app.world_mut().trigger(LinkStart { entity });
    app.insert_resource(Match {
        players: (0..count).map(|_| Player::default()).collect(),
        token,
        authority: None,
        authority_ready: false,
        started: false,
        ended: false,
        tick: 0,
        next_step: Instant::now(),
        in_flight: None,
    });
    app.add_systems(Update, update);
    let started = Instant::now();
    while app.world().get::<Linked>(entity).is_none() {
        if started.elapsed() > Duration::from_secs(3) {
            return Err(format!("Unable to listen on {addr}").into());
        }
        app.update();
        thread::sleep(Duration::from_millis(1));
    }
    println!("Lightyear listening on ws://{addr} for {count} players");
    loop {
        app.update();
        thread::sleep(Duration::from_millis(1));
    }
}
