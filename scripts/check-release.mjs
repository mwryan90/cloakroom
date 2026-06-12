/**
 * Release preflight. Three releases have gone out mid-feature because main's
 * version was already published while new work kept merging under it. Refuse
 * to publish a version the registry already has, or from a dirty tree.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const version = JSON.parse(readFileSync("packages/cli/package.json", "utf8")).version;

let published = "";
try {
  published = execSync(`npm view cloakroom@${version} version`, {
    stdio: ["ignore", "pipe", "ignore"],
  })
    .toString()
    .trim();
} catch {
  /* not published — good */
}
if (published) {
  console.error(
    `cloakroom@${version} is already on the registry.\n` +
      `Anything merged after that publish is NOT in it — bump all package versions\n` +
      `(lockstep) and update the changelog before releasing.`,
  );
  process.exit(1);
}

const dirty = execSync("git status --porcelain").toString().trim();
if (dirty) {
  console.error("Working tree is not clean — commit or stash before releasing.");
  process.exit(1);
}

const behind = execSync("git rev-list --count HEAD..origin/main").toString().trim();
if (behind !== "0") {
  console.error(`Local main is ${behind} commit(s) behind origin/main — git pull first.`);
  process.exit(1);
}

console.log(`[preflight] ok — releasing ${version} from a clean, up-to-date tree`);
