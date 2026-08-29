/**
 * Point Git at the tracked hooks directory.
 *
 * Hooks in .git/hooks are private to one clone and vanish with it, so they
 * cannot be a project control. Setting core.hooksPath to a tracked directory
 * makes the same gate available to everyone who runs this once.
 *
 *   npm run hooks:install
 */
import { execFileSync } from "node:child_process";

execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "inherit" });
console.log("core.hooksPath is now .githooks");
console.log("pre-commit and commit-msg will run the cheap verification gates.");
