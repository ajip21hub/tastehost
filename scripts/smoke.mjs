// Usage: node scripts/smoke.mjs [jakarta|bandung] [baseUrl]
const presets = {
  jakarta: { city: "Jakarta", occasion: "Friday night out", categories: ["dining", "culture", "nightlife"], members: [
    { name: "Aji", loves: ["Radiohead", "Studio Ghibli", "ramen"] },
    { name: "Dina", loves: ["Taylor Swift", "Gilmore Girls", "matcha"] },
    { name: "Raka", loves: ["Hindia", "Interstellar", "sate padang"] } ] },
  bandung: { city: "Bandung", occasion: "Team offsite", categories: ["dining", "coffee", "culture"], members: [
    { name: "Sari", loves: ["Norah Jones", "Haruki Murakami"] },
    { name: "Budi", loves: ["Manchester United", "Fast & Furious"] },
    { name: "Lia", loves: ["BTS", "Crash Landing on You"] },
    { name: "Tom", loves: ["Anthony Bourdain", "The Bear"] } ] },
};
const name = process.argv[2] || "jakarta";
const base = process.argv[3] || "http://localhost:3000";
const t0 = Date.now();
const res = await fetch(`${base}/api/plan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(presets[name]) });
if (!res.ok) { console.error("HTTP", res.status, await res.text()); process.exit(1); }
const text = await res.text();
for (const line of text.split("\n").filter(Boolean)) {
  const e = JSON.parse(line);
  if (e.type === "step") console.log(`STEP ${e.tool} [${e.source ?? "-"}] ${e.ms ?? ""}ms | ${(e.detail ?? e.label).slice(0, 220)}`);
  else if (e.type === "thought") console.log(`THOUGHT ${e.text.slice(0, 200).replace(/\n/g, " ")}`);
  else if (e.type === "plan") {
    console.log(`PLAN: ${e.plan.title}\n  ${e.plan.summary}\n  shared: ${e.plan.sharedTaste.slice(0, 8).map((t) => `${t.tag}x${t.members.length}`).join(", ")}`);
    for (const p of e.plan.picks) {
      console.log(`  - ${p.category}: ${p.place.name} (fit ${p.place.groupScore}, fairness ${p.place.fairness}) ${p.place.address?.slice(0, 50) ?? ""}\n    why: ${p.why}`);
      for (const [m, r] of Object.entries(p.perMember)) console.log(`      ${m}: ${r}`);
    }
  } else if (e.type === "generic") console.log(`GENERIC(${e.source}): ${e.text.replace(/\n/g, " | ").slice(0, 300)}`);
  else console.log(e.type.toUpperCase(), JSON.stringify(e).slice(0, 300));
}
console.log(`total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
