// A second process for the WAL concurrency test: it opens the same file and
// writes `count` cards as fast as it can.
// Usage: <db path> <project id> <count> <label>
import { openLocalStore } from "./store";

const [path, project, count, label] = process.argv.slice(2);
if (!path || !project || !count) {
  console.error("usage: writer.fixture.ts <db> <project> <count> <label>");
  process.exit(2);
}
const store = openLocalStore({ path });
try {
  for (let index = 0; index < Number(count); index += 1) {
    const card = store.createWorkItem(project, {
      title: `${label} card ${index}`,
      categoryKey: "frontend",
    });
    store.addCheckpoint(card.id, { summary: `${label} ${index}` });
  }
} finally {
  store.close();
}
console.log("ok");
