import { describe, expect, test } from "bun:test";

import {
  arborCloneUrl,
  diffRefs,
  parseLsRemote,
  parseRepoSpec,
  toSlug,
} from "./migrate";

describe("parseRepoSpec", () => {
  test("parses owner/name", () => {
    expect(parseRepoSpec("omnidotdev/arbor-api")).toEqual({
      owner: "omnidotdev",
      name: "arbor-api",
    });
  });

  test("parses a full GitHub URL", () => {
    expect(parseRepoSpec("https://github.com/omnidotdev/arbor-api")).toEqual({
      owner: "omnidotdev",
      name: "arbor-api",
    });
  });

  test("strips a .git suffix", () => {
    expect(parseRepoSpec("git@github.com:omnidotdev/arbor-api.git")).toEqual({
      owner: "omnidotdev",
      name: "arbor-api",
    });
  });

  test("rejects a bare name with no owner", () => {
    expect(parseRepoSpec("arbor-api")).toBeNull();
  });
});

describe("toSlug", () => {
  test("lowercases and hyphenates", () => {
    expect(toSlug("Arbor API")).toBe("arbor-api");
  });

  test("leaves an already-valid slug untouched", () => {
    expect(toSlug("arbor-api")).toBe("arbor-api");
  });

  test("collapses runs of separators", () => {
    expect(toSlug("my  weird__name")).toBe("my-weird-name");
  });

  test("trims leading and trailing separators", () => {
    expect(toSlug("-arbor-")).toBe("arbor");
  });
});

describe("arborCloneUrl", () => {
  test("builds the clean clone URL", () => {
    expect(arborCloneUrl("git.arbor.omni.dev", "omnidotdev", "arbor-api")).toBe(
      "https://git.arbor.omni.dev/omnidotdev/arbor-api.git",
    );
  });
});

describe("diffRefs", () => {
  const source = new Map([
    ["refs/heads/master", "aaa"],
    ["refs/tags/v1", "bbb"],
  ]);

  test("reports parity when every ref matches", () => {
    const result = diffRefs(source, new Map(source));
    expect(result.inSync).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.mismatched).toEqual([]);
  });

  test("reports refs absent from the destination", () => {
    const result = diffRefs(source, new Map([["refs/heads/master", "aaa"]]));
    expect(result.inSync).toBe(false);
    expect(result.missing).toEqual(["refs/tags/v1"]);
  });

  test("reports refs that point at a different commit", () => {
    const result = diffRefs(
      source,
      new Map([
        ["refs/heads/master", "zzz"],
        ["refs/tags/v1", "bbb"],
      ]),
    );
    expect(result.inSync).toBe(false);
    expect(result.mismatched).toEqual(["refs/heads/master"]);
  });

  test("extra destination refs do not break parity", () => {
    // A mirror push never deletes on the destination, so extras are reported
    // but are not treated as a failure
    const result = diffRefs(
      source,
      new Map([...source, ["refs/heads/stale", "ccc"]]),
    );
    expect(result.extra).toEqual(["refs/heads/stale"]);
    expect(result.inSync).toBe(true);
  });
});

describe("parseLsRemote", () => {
  test("maps refs to their commit shas", () => {
    const refs = parseLsRemote(
      "aaa\trefs/heads/master\nbbb\trefs/tags/v1\n",
    );
    expect(refs.get("refs/heads/master")).toBe("aaa");
    expect(refs.get("refs/tags/v1")).toBe("bbb");
  });

  test("ignores peeled tag entries so an annotated tag is not double counted", () => {
    const refs = parseLsRemote(
      "bbb\trefs/tags/v1\nccc\trefs/tags/v1^{}\n",
    );
    expect(refs.size).toBe(1);
    // the tag object, not the commit it peels to
    expect(refs.get("refs/tags/v1")).toBe("bbb");
  });

  test("skips blank and malformed lines", () => {
    expect(parseLsRemote("\n   \ngarbage\n").size).toBe(0);
  });
});
