import { expect, test } from "bun:test";

const cli = JSON.stringify(import.meta.resolve("../../tools/cli.js"));
const wrap = (body: string) =>
  `import { $ } from "bun"; import { runCli } from ${cli}; await runCli(async () => { ${body} });`;

async function execute(code: string) {
  const child = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, status };
}

test("CLI retains command diagnostics and exit code without dumping captured output", async () => {
  const command = JSON.stringify(
    'console.log("build progress"); console.error("compiler: missing symbol"); process.exit(23);',
  );
  const result = await execute(
    wrap(
      `try { await $\`\${process.execPath} -e \${${command}}\`; } finally { console.log("cleanup"); }`,
    ),
  );
  expect(result.status).toBe(23);
  expect(result.stdout).toBe("build progress\ncleanup\n");
  expect(result.stderr).toBe("compiler: missing symbol\nerror: Failed with exit code 23\n");
});

test("nested CLI failures do not repeat child stdout or stderr", async () => {
  const command = JSON.stringify('console.error("compiler: missing header"); process.exit(7);');
  const inner = wrap(`await $\`\${process.execPath} -e \${${command}}\`;`);
  const result = await execute(
    wrap(`await $\`\${process.execPath} -e \${${JSON.stringify(inner)}}\`;`),
  );
  expect(result.status).toBe(7);
  expect(result.stdout).toBe("");
  expect(result.stderr.match(/compiler: missing header/g)).toHaveLength(1);
  expect(result.stderr).not.toContain("ShellError");
  expect(result.stderr).not.toContain("stdout:");
  expect(result.stderr).not.toContain("stderr:");
});

test("CLI preserves unexpected JavaScript errors for debugging", async () => {
  const result = await execute(wrap('throw new TypeError("unexpected failure");'));
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("TypeError: unexpected failure");
});
