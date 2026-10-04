import { openWindows, activeWindow } from "active-win";

const wins = await openWindows();
console.log("openWindows ->", wins === undefined ? "undefined" : `array(${wins.length})`);
if (Array.isArray(wins)) {
	for (const w of wins.slice(0, 10)) {
		console.log(JSON.stringify({ title: w.title, id: w.id, bounds: w.bounds, owner: w.owner?.name, path: w.owner?.path }));
	}
}
const fg = await activeWindow();
console.log("activeWindow ->", fg === undefined ? "undefined" : JSON.stringify({ title: fg.title, id: fg.id, owner: fg.owner?.name }));
