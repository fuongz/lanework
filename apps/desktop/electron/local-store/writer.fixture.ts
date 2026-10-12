// A second process for the WAL concurrency test: opens the same file and
// writes `count` cards as fast as it can. Usage: <db path> <workspace id> <count> <label>
import { openLocalStore } from "./store";

const [path, workspace, count, label] = process.argv.slice(2);
if (!path || !workspace || !count) {
  console.error("usage: writer.fixture.ts <db> <workspace> <count> <label>");
  process.exit(2);
}
const store = openLocalStore({ path });
try {
  for (let index = 0; index < Number(count); index += 1) {
    const card = store.createWorkItem(workspace, {
      title: `${label} card ${index}`,
      categoryKey: "frontend",
    });
    store.addCheckpoint(card.id, { summary: `${label} ${index}` });
  }
} finally {
  store.close();
}
console.log("ok");
