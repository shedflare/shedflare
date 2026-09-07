import { describe, expect, test } from "vite-plus/test";
import { spawnSync } from "node:child_process";
import { defaultDownloadPath, downloadCommand, uploadCommand } from "./cli-commands";

describe("CLI command shell arguments", () => {
  const paths = [
    "/tmp/my report.pdf",
    "/tmp/owner's file.txt",
    '/tmp/$(exit 42)`exit 42`"$USER.txt',
    "-",
    "~/Downloads/my file.txt",
  ];

  test.each(paths)("download keeps %s as a single literal destination", (path) => {
    const command = downloadCommand({
      downloadUrl: "https://drive.example/api/cli-downloads/id?token=abc.def",
      path,
    });
    const result = spawnSync("bash", ["-c", `curl() { printf '%s\\0' "$@"; }; ${command}`], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const args = result.stdout.split("\0");
    const expected = path.startsWith("~/")
      ? `${process.env.HOME}/${path.slice(2)}`
      : path === "-"
        ? "./-"
        : path;
    expect(args[args.indexOf("--output") + 1]).toBe(expected);
    expect(args.at(-2)).toBe("https://drive.example/api/cli-downloads/id?token=abc.def");
  });

  test.each(paths)("upload passes %s literally through the nested Bash invocation", (path) => {
    // Supply a local uploader script through curl's shell function, then execute both real Bash layers.
    const script = "printf '%s' \"$1\"";
    const command = uploadCommand({ clientUrl: "https://drive.example/client/token.sh", path });
    const result = spawnSync(
      "bash",
      ["-c", `curl() { printf '%s' "$CLI_TEST_SCRIPT"; }; export -f curl; ${command}`],
      {
        encoding: "utf8",
        env: { ...process.env, CLI_TEST_SCRIPT: script },
      },
    );
    expect(result.status).toBe(0);
    const expected = path.startsWith("~/")
      ? `${process.env.HOME}/${path.slice(2)}`
      : path === "-"
        ? "./-"
        : path;
    expect(result.stdout).toBe(expected);
  });

  test("the suggested download path stays inside the working directory", () => {
    expect(defaultDownloadPath("../../report.pdf")).toBe("./report.pdf");
    expect(defaultDownloadPath("C:\\secret\\report.pdf")).toBe("./report.pdf");
    expect(defaultDownloadPath("..")).toBe("./download");
    expect(defaultDownloadPath("-")).toBe("./-");
  });
});
