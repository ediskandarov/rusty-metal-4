import { DurableObject } from "cloudflare:workers";

import { type ChallengePlayer, completion } from "../challenge.ts";
import { failure, json, readJson } from "../http.ts";
import { object, RoomError, text } from "../room-state.ts";
import type { Env } from "./index.ts";

type PlayerRow = { id: string; name: string };
type CompletionRow = { model: string; map: string; date: string; version: string };

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
  }

  private player(id: string): ChallengePlayer | null {
    const row = this.ctx.storage.sql
      .exec<PlayerRow>("SELECT id, name FROM players WHERE id = ?", id)
      .toArray()[0];
    if (!row) return null;
    const completions = this.ctx.storage.sql
      .exec<CompletionRow>(
        "SELECT model, map, date, version FROM completions WHERE identity = ? ORDER BY date, model",
        id,
      )
      .toArray();
    return { ...row, score: completions.length, completions };
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
          GROUP BY players.id HAVING COUNT(completions.model) > 0
          ORDER BY COUNT(completions.model) DESC, MIN(completions.date), players.id LIMIT 100`,
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
        if (!this.player(id)) throw new RoomError(400, "Save your display name before playing.");
        const value = completion(await readJson(request));
        const date = new Date().toISOString();
        const added =
          this.ctx.storage.sql
            .exec<CompletionRow>(
              `INSERT INTO completions(identity, model, map, date, version) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(identity, model) DO NOTHING RETURNING model, map, date, version`,
              id,
              value.model,
              value.map,
              date,
              value.version,
            )
            .toArray().length !== 0;
        return json({ added, player: this.player(id) });
      }
      throw new RoomError(404, "Unknown challenge endpoint.");
    } catch (error) {
      return failure(error);
    }
  }
}
