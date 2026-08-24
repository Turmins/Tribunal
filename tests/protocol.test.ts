import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promptFor, roles } from "../src/prompts-registry.js";

test("protocol has exactly balanced four advocates and three judges",()=>{
  assert.equal(roles.length,7);
  assert.deepEqual(roles.filter(r=>r.role==="advocate").map(r=>r.stance),["justified","justified","not_justified","not_justified"]);
  assert.equal(roles.filter(r=>r.role==="judge").length,3);
});
test("source contains no verdict-combining vocabulary",async()=>{
  const files=(await readdir("src")).filter(f=>f.endsWith(".ts"));
  const source=(await Promise.all(files.map(f=>readFile(path.join("src",f),"utf8")))).join("\n");
  assert.doesNotMatch(source,/(consensus|majority|aggregate|merge.*verdict|final.*verdict|winner|average.*decision)/i);
});
test("all seven slots compose into substantive prompts",async()=>{
  for(const role of roles){
    const prompt=await promptFor(role.name);
    assert.ok(prompt.text.length>800,`${role.name}: composed prompt is suspiciously short`);
    assert.ok(prompt.version.includes("+"),`${role.name}: version is not composed from blocks`);
  }
});
