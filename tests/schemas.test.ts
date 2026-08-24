import assert from "node:assert/strict";
import test from "node:test";
import { indictmentSchema, validateModelOutput, ContractError } from "../src/schemas.js";

const reasoning="This reasoning is deliberately long enough to satisfy the contract. It distinguishes the submitted record from assumptions, acknowledges uncertainty, tests the opposing position, and does not invent facts. It is deterministic fixture content for verification only.";
test("charge sheet normalization and strict fields",()=>{
  const result=indictmentSchema.parse({defendant:"  Team  ",act:"Made a decision under review",question:"Was the decision justified?"});
  assert.equal(result.defendant,"Team");
  assert.throws(()=>indictmentSchema.parse({...result,extra:true}));
});
test("advocate must keep assigned stance",()=>{
  assert.throws(()=>validateModelOutput(JSON.stringify({position:"not_justified",reasoning}),"advocate","justified"),(error:any)=>error instanceof ContractError&&error.layer==="L5");
});
test("judge and advocate contracts cannot be confused",()=>{
  assert.throws(()=>validateModelOutput(JSON.stringify({decision:"justified",reasoning}),"advocate","justified"));
  assert.throws(()=>validateModelOutput(JSON.stringify({position:"justified",reasoning}),"judge",null));
});
test("valid contracts pass",()=>{
  assert.equal((validateModelOutput(JSON.stringify({position:"justified",reasoning}),"advocate","justified") as any).position,"justified");
  assert.equal((validateModelOutput(JSON.stringify({decision:"not_justified",reasoning}),"judge",null) as any).decision,"not_justified");
});
