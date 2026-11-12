import type { RoomSummary } from "../../apps/rustymetal4.com/src/protocol.ts";
import { RoomDirectory as ProductionDirectory } from "../../apps/rustymetal4.com/src/worker/directory.ts";
import { Room as ProductionRoom } from "../../apps/rustymetal4.com/src/worker/room.ts";

export { default } from "../../apps/rustymetal4.com/src/worker/index.ts";

// These inspection/fault controls exist only in the local integration worker bundle.
export class Room extends ProductionRoom {
  async ageSilentSocketsForTest() {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as {
        memberId: string;
        connectionId: string;
        connectedAt: number;
      };
      socket.serializeAttachment({ ...attachment, connectedAt: Date.now() - 71_000 });
    }
    await this.ctx.storage.setAlarm(Date.now());
  }
  async inspectForTest() {
    return {
      entries: [...(await this.ctx.storage.list())],
      alarm: await this.ctx.storage.getAlarm(),
      sockets: this.ctx.getWebSockets().length,
    };
  }
}
export class RoomDirectory extends ProductionDirectory {
  private unavailable = false;
  setUnavailableForTest(value: boolean) {
    this.unavailable = value;
  }
  async expireListingsForTest() {
    const entries = await this.ctx.storage.list<{ summary: RoomSummary; expiresAt: number }>({
      prefix: "room:",
    });
    for (const [key, value] of entries) {
      const expired = { ...value, expiresAt: Date.now() - 1 };
      await this.ctx.storage.put(key, expired);
      this.listings.set(key, expired);
    }
    await super.alarm();
  }
  async inspectDirectoryForTest() {
    return {
      entries: [...(await this.ctx.storage.list())],
      alarm: await this.ctx.storage.getAlarm(),
    };
  }
  override async publish(id: string, summary: RoomSummary | null) {
    if (this.unavailable) throw new Error("Directory outage for integration test");
    return super.publish(id, summary);
  }
}
