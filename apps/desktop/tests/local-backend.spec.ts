// FE-52 main-process checks, driven through the real IPC from a real window:
//
//   V2 — local mode sends NO request to the control plane. The app is pointed
//        at a stub plane that records every request, and the whole board flow
//        (create, edit, drag, checklist, status) runs against the local store.
//   V3 — signed in, "Sync to cloud" uploads the board, and an upload that
//        fails part way leaves the local board intact and writable.
//
// The renderer's own local-mode screens are W2's (`local-mode.spec.ts`); this
// file only talks to `window.desktop`.
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { DesktopApi } from "../shared/desktop";
import {
  launchEnv,
  removeProfile,
  seedCredential,
  startStubPlane,
} from "./auth-fixtures";

type Desktop = { desktop: DesktopApi };

test("local mode runs the whole board without a single request to the control plane", async () => {
  const plane = await startStubPlane();
  const profile = await mkdtemp(join(tmpdir(), "lanew-local-"));
  const home = join(profile, "home");
  const app = await electron.launch({
    args: [process.cwd()],
    env: launchEnv({ profile, home, apiUrl: plane.origin }),
  });
  try {
    const page = await app.firstWindow();
    const result = await page.evaluate(async () => {
      const { auth, projects } = (globalThis as unknown as Desktop).desktop;
      const fail = async (run: () => Promise<unknown>) => {
        try {
          await run();
          return "unexpected success";
        } catch (error) {
          return (error as Error).message;
        }
      };
      const session = await auth.enterLocalMode();
      const created = await projects.create("Offline board");
      const ws = created.active?.id as string;
      const board = projects.board;

      const first = await board.create(ws, {
        title: "Plan the offline board",
        categoryKey: "frontend",
        priority: "high",
        tags: ["local"],
      });
      const second = await board.create(ws, { title: "Second card" });
      if (first.kind !== "ok" || second.kind !== "ok")
        throw new Error("create failed");
      const edited = await board.update(
        ws,
        first.card.id,
        { body: "Written with no network" },
        first.card.revision,
      );
      if (edited.kind !== "ok") throw new Error("edit failed");
      // Drag and drop: into To-Do, then above the other card.
      const dragged = await board.move(ws, first.card.id, "todo");
      await board.move(ws, second.card.id, "todo");
      const reordered = await board.move(ws, second.card.id, null, {
        before: first.card.id,
      });
      if (reordered.kind !== "ok") throw new Error("reorder failed");
      const listed = await board.setChecklist(
        ws,
        first.card.id,
        [
          { key: "D1", section: "decisions", text: "Ship local mode" },
          { key: "V1", section: "verify", text: "No requests" },
        ],
        dragged.kind === "ok" ? dragged.card.revision : 0,
      );
      if (listed.kind !== "ok") throw new Error("checklist failed");
      const ticked = await board.toggle(
        ws,
        first.card.id,
        "D1",
        true,
        listed.card.revision,
      );
      // Set status: Done.
      const done = await board.move(ws, first.card.id, "done");
      const view = await board.load(ws);
      const card = await board.card(ws, first.card.id);
      const found = await board.lookup(ws, "FE-01");
      const searched = await board.search(ws, "offline");
      const changes = await board.changes(ws, 0);
      const comment = await fail(() =>
        board.comment(ws, first.card.id, "hello"),
      );
      const sync = await fail(() => projects.syncToCloud(ws));
      const reloaded = await projects.load();
      if (!reloaded.ok) throw new Error("read failed");
      const snapshot = reloaded.snapshot;
      return {
        principal: session.principal.kind,
        origin: created.active?.origin,
        taskId: first.card.taskId,
        ticked: ticked.kind === "ok" ? ticked.card.checklistProgress : null,
        done: done.kind === "ok" ? done.card.columnKey : done.kind,
        lanes: view.cards.map((entry) => [entry.title, entry.columnKey]),
        todoOrder: view.cards
          .filter((entry) => entry.columnKey === "todo")
          .map((entry) => entry.title),
        detailChecklist: card.checklist?.map((item) => [
          item.key,
          item.checked,
        ]),
        body: card.body,
        found: found?.id === first.card.id,
        searched: searched.length,
        changed: changes.cards.length,
        comment,
        sync,
        listed: snapshot.projects.map((entry) => entry.name),
        active: snapshot.active?.id === ws,
      };
    });

    expect(result.principal).toBe("local");
    expect(result.origin).toBe("local");
    expect(result.taskId).toBe("FE-01");
    expect(result.ticked).toEqual({ done: 1, total: 2 });
    expect(result.done).toBe("done");
    expect(result.lanes).toEqual(
      expect.arrayContaining([
        ["Plan the offline board", "done"],
        ["Second card", "todo"],
      ]),
    );
    expect(result.detailChecklist).toEqual([
      ["D1", true],
      ["V1", false],
    ]);
    expect(result.body).toBe("Written with no network");
    expect(result.found).toBe(true);
    expect(result.searched).toBe(1);
    expect(result.changed).toBeGreaterThanOrEqual(2);
    expect(result.comment).toMatch(/only on cloud boards/);
    expect(result.sync).toMatch(/Sign in/);
    expect(result.listed).toEqual(["Offline board"]);
    expect(result.active).toBe(true);
    expect(existsSync(join(home, "data.sqlite"))).toBe(true);

    // Let the renderer settle: anything it would ask the plane, it has asked.
    await page.waitForTimeout(1500);
    expect(plane.calls).toEqual([]);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});

test("signed in, Sync to cloud moves the local board, and a failed upload loses nothing", async () => {
  const plane = await startStubPlane();
  const profile = await mkdtemp(join(tmpdir(), "lanew-sync-"));
  const home = join(profile, "home");
  const env = launchEnv({ profile, home, apiUrl: plane.origin });

  // Launch 1, local mode: make the board.
  let app = await electron.launch({ args: [process.cwd()], env });
  let localId = "";
  try {
    const page = await app.firstWindow();
    localId = await page.evaluate(async () => {
      const { auth, projects } = (globalThis as unknown as Desktop).desktop;
      await auth.enterLocalMode();
      const created = await projects.create("Offline board");
      const ws = created.active?.id as string;
      const card = await projects.board.create(ws, {
        title: "Carry me",
        categoryKey: "backend",
      });
      if (card.kind !== "ok") throw new Error("create failed");
      await projects.board.setChecklist(
        ws,
        card.card.id,
        [{ key: "D1", section: "decisions", text: "Moved", checked: true }],
        card.card.revision,
      );
      await projects.board.create(ws, { title: "And me" });
      return ws;
    });
  } finally {
    await app.close();
  }
  expect(plane.calls).toEqual([]);

  // Launch 2, signed in: the local board is still listed, beside the cloud.
  await seedCredential(home, plane.origin);
  plane.setBoard("ws-offline-board", {
    columns: [
      { key: "backlog", name: "Backlog", role: "intake" },
      { key: "todo", name: "To-Do", role: "start" },
      { key: "processing", name: "In Progress", role: "active" },
      { key: "done", name: "Done", role: "done" },
      { key: "dropped", name: "Archived", role: "archive" },
    ],
    cards: [],
  });
  app = await electron.launch({ args: [process.cwd()], env });
  try {
    const page = await app.firstWindow();

    // The upload fails: nothing local changes, and the board stays writable.
    plane.setImportBroken(true);
    const failed = await page.evaluate(async (ws) => {
      const { projects } = (globalThis as unknown as Desktop).desktop;
      const listed = await projects.load();
      if (!listed.ok) throw new Error("read failed");
      const snapshot = listed.snapshot;
      let error = "";
      try {
        await projects.syncToCloud(ws);
      } catch (caught) {
        error = (caught as Error).message;
      }
      // The view is read again only once the failure is over: nothing about
      // it should linger in this machine's own boards.
      const view = await projects.board.load(ws);
      const write = await projects.board.create(ws, {
        title: "Written after the failure",
      });
      return {
        local: snapshot.projects.find((entry) => entry.id === ws)?.origin,
        error,
        movedTo: snapshot.projects.find((entry) => entry.id === ws)?.movedTo,
        cards: view.cards.map((card) => card.title).sort(),
        write: write.kind,
      };
    }, localId);
    expect(failed.local).toBe("local");
    expect(failed.error).toMatch(/Nothing on this machine was changed/);
    expect(failed.movedTo).toBeNull();
    expect(failed.cards).toEqual(["And me", "Carry me"]);
    expect(failed.write).toBe("ok");
    expect(plane.sealed).toEqual([]);

    // Run again: it finishes, into the same project.
    plane.setImportBroken(false);
    const moved = await page.evaluate(async (ws) => {
      const { projects } = (globalThis as unknown as Desktop).desktop;
      const result = await projects.syncToCloud(ws);
      const write = await projects.board.create(ws, { title: "Too late" });
      const local = result.snapshot.projects.find((entry) => entry.id === ws);
      return {
        cloudId: result.cloudId,
        cards: result.cards,
        active: result.snapshot.active?.id,
        movedTo: local?.movedTo,
        write: write.kind,
      };
    }, localId);
    expect(moved.cloudId).toBe("ws-offline-board");
    expect(moved.cards).toBe(3);
    expect(moved.active).toBe("ws-offline-board");
    expect(moved.movedTo).toBe("ws-offline-board");
    expect(moved.write).toBe("error");
    expect(plane.sealed).toEqual([{ items: 3, manifest: expect.any(String) }]);
    const carried = plane.imported.find((entry) => entry.checklist === 1);
    expect(carried?.columnKey).toBe("backlog");
    expect(
      plane.calls.filter((call) => call === "POST /v1/sync/state/workspace"),
    ).toHaveLength(1);
  } finally {
    await app.close();
    await plane.close();
    await removeProfile(profile);
  }
});
