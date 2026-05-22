import { spawn } from "node:child_process";

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
      env: process.env,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with ${code}`));
    });
  });
}

if (!process.env.DATABASE_URL?.trim()) {
  console.warn("[start] DATABASE_URL is not set — skipping prisma db push");
} else {
  try {
    await run("npx", ["prisma", "db", "push", "--skip-generate"]);
  } catch (e) {
    console.warn(
      "[start] prisma db push failed — starting web anyway:",
      e instanceof Error ? e.message : e,
    );
  }
}

const port = process.env.PORT?.trim() || "3000";
const hostname = process.env.HOSTNAME?.trim() || "0.0.0.0";

const next = spawn(
  "npx",
  ["next", "start", "-H", hostname, "-p", port],
  { stdio: "inherit", env: process.env, shell: process.platform === "win32" },
);

next.on("error", (err) => {
  console.error("[start] next start failed:", err);
  process.exit(1);
});

next.on("close", (code) => {
  process.exit(code ?? 1);
});
