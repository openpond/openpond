import { describe, expect, test } from "bun:test";

import { detectComposerRepoLinks } from "../apps/web/src/lib/composer-repo-links";

describe("composer repo link detection", () => {
  test("detects GitHub repository URLs and trims punctuation from the match", () => {
    const content = "Review https://github.com/openpond/openpondai.git, then report back.";
    const links = detectComposerRepoLinks(content);

    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      provider: "github",
      host: "github.com",
      label: "openpond/openpondai",
      owner: "openpond",
      repo: "openpondai",
      url: "https://github.com/openpond/openpondai.git",
    });
    expect(content.slice(links[0]!.start, links[0]!.end)).toBe("https://github.com/openpond/openpondai.git");
  });

  test("detects bare GitHub repo URLs and keeps deep links as the chip title target", () => {
    const links = detectComposerRepoLinks("Check github.com/openpond/openpondai/pull/42");

    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      provider: "github",
      label: "openpond/openpondai",
      url: "github.com/openpond/openpondai/pull/42",
    });
  });

  test("detects OpenPond git remotes with the OpenPond provider", () => {
    const links = detectComposerRepoLinks("Use https://openpond.ai/openpondai/imported-opentool.git");

    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      provider: "openpond",
      host: "openpond.ai",
      label: "openpondai/imported-opentool",
      owner: "openpondai",
      repo: "imported-opentool",
    });
  });

  test("detects SSH-style Git remotes", () => {
    const links = detectComposerRepoLinks(
      "Compare git@github.com:openpond/openpondai.git with git@openpond.ai:openpondai/imported-opentool.git",
    );

    expect(links.map((link) => [link.provider, link.label, link.url])).toEqual([
      ["github", "openpond/openpondai", "git@github.com:openpond/openpondai.git"],
      ["openpond", "openpondai/imported-opentool", "git@openpond.ai:openpondai/imported-opentool.git"],
    ]);
  });

  test("ignores common non-repository OpenPond and GitHub pages", () => {
    expect(detectComposerRepoLinks("https://openpond.ai/settings/api-keys")).toEqual([]);
    expect(detectComposerRepoLinks("https://github.com/features/actions")).toEqual([]);
  });
});
