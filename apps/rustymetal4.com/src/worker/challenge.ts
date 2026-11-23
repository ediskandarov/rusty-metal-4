import { DurableObject } from "cloudflare:workers";

import { type ChallengePlayer, completion } from "../challenge.ts";
import { failure, json, readJson } from "../http.ts";
import { object, RoomError, text } from "../room-state.ts";
import type { Env } from "./index.ts";

type PlayerRow = { id: string; name: string };
type CompletionRow = {
  model: string;
  map: string;
  date: string;
  version: string;
  bestFrags: number | null;
  bestMap: string | null;
  bestDate: string | null;
};

/* Browser reports are deliberately trusted. The unique (identity, model) key is the score rule,
 * not an anti-cheat mechanism; two people may use exactly the same display name. */
export class ChallengeLeaderboard extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY, name TEXT NOT NULL
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS completions (
      identity TEXT NOT NULL, model TEXT NOT NULL, map TEXT NOT NULL,
      date TEXT NOT NULL, version TEXT NOT NULL, PRIMARY KEY(identity, model)
    )`);
    // A missing record means the original player reported a win without measuring frags.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS car_records (
      identity TEXT NOT NULL, model TEXT NOT NULL, frags INTEGER NOT NULL,
      map TEXT NOT NULL, date TEXT NOT NULL, PRIMARY KEY(identity, model)
    )`);
  }

  private player(id: string): ChallengePlayer | null {
    const row = this.ctx.storage.sql
      .exec<PlayerRow>("SELECT id, name FROM players WHERE id = ?", id)
      .toArray()[0];
    if (!row) return null;
    const completions = this.ctx.storage.sql
      .exec<CompletionRow>(
        `SELECT c.model, c.map, c.date, c.version, r.frags AS bestFrags,
                r.map AS bestMap, r.date AS bestDate
         FROM completions c LEFT JOIN car_records r USING(identity, model)
         WHERE c.identity = ? ORDER BY c.date, c.model`,
        id,
      )
      .toArray();
    return {
      ...row,
      score: completions.length,
      totalScore: completions.reduce((sum, car) => sum + (car.bestFrags ?? 0), 0),
      completions,
    };
  }

  override async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      const id = request.headers.get("x-challenge-identity") ?? "";
      if (request.method === "GET" && path === "/leaderboard") {
        const rows = this.ctx.storage.sql
          .exec<PlayerRow>(
            `SELECT players.id, players.name
          FROM players LEFT JOIN completions ON players.id = completions.identity
          LEFT JOIN car_records USING(identity, model)
          GROUP BY players.id HAVING COUNT(completions.model) > 0
          ORDER BY COALESCE(SUM(car_records.frags), 0) DESC, COUNT(completions.model) DESC, MIN(completions.date), players.id LIMIT 100`,
          )
          .toArray();
        return json({ players: rows.map((row) => this.player(row.id)) });
      }
      if (!/^[a-f0-9]{64}$/.test(id)) throw new RoomError(401, "Enable cookies and try again.");
      if (request.method === "GET" && path === "/profile") return json({ player: this.player(id) });
      if (request.method === "POST" && path === "/profile") {
        const input = object(await readJson(request));
        const name = text(input.name, "Your name", 24);
        this.ctx.storage.sql.exec(
          "INSERT INTO players(id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name",
          id,
          name,
        );
        return json({ player: this.player(id) });
      }
      if (request.method === "POST" && path === "/completion") {
        const value = completion(await readJson(request));
        const previous = this.player(id);
        if (!previous) throw new RoomError(400, "Save your display name before playing.");
        const date = new Date().toISOString();
        const added = this.ctx.storage.transactionSync(() => {
          const inserted =
            this.ctx.storage.sql
              .exec(
                `INSERT INTO completions(identity, model, map, date, version) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(identity, model) DO NOTHING RETURNING model`,
                id,
                value.model,
                value.map,
                date,
                value.version,
              )
              .toArray().length > 0;
          if (value.frags !== undefined)
            this.ctx.storage.sql.exec(
              `INSERT INTO car_records(identity, model, frags, map, date) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(identity, model) DO UPDATE SET
                 frags = excluded.frags, map = excluded.map, date = excluded.date
               WHERE excluded.frags > car_records.frags`,
              id,
              value.model,
              value.frags,
              value.map,
              date,
            );
          return inserted;
        });
        const player = this.player(id)!;
        return json({ added, player, gain: player.totalScore - previous.totalScore });
      }
      throw new RoomError(404, "Unknown challenge endpoint.");
    } catch (error) {
      return failure(error);
    }
  }
}
