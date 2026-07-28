import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  composerProfileTargetForLibrary,
  openPondProfileRefFromKey,
  openPondProfileRefKey,
  openPondProfileRefsEqual,
} from "../apps/web/src/lib/profile-selection";
import { ComposerProfileTargetControl } from "../apps/web/src/components/chat/ComposerControls";

describe("Profile selection keys", () => {
  test("round-trips refs without collisions between repositories", () => {
    const first = { source: "local" as const, repositoryId: "/profiles/a", profileId: "default" };
    const second = { source: "local" as const, repositoryId: "/profiles/b", profileId: "default" };
    const library = {
      lastUsed: first,
      profiles: [
        { ref: first, name: "default", repoPath: "/profiles/a", sourcePath: null, state: {} as never },
        { ref: second, name: "default", repoPath: "/profiles/b", sourcePath: null, state: {} as never },
      ],
    };
    expect(openPondProfileRefKey(first)).not.toBe(openPondProfileRefKey(second));
    expect(openPondProfileRefFromKey(library, openPondProfileRefKey(second))).toEqual(second);
    expect(openPondProfileRefsEqual(first, second)).toBe(false);
    expect(composerProfileTargetForLibrary(library, second)).toMatchObject({
      label: "default",
      value: openPondProfileRefKey(second),
    });
    expect(composerProfileTargetForLibrary({
      ...library,
      profiles: library.profiles.slice(0, 1),
    }, first)).toBeNull();
  });

  test("hides the composer Profile control for one Profile and shows it for multiple", () => {
    const one = renderToStaticMarkup(createElement(ComposerProfileTargetControl, {
      busy: false,
      placement: "top",
      state: { value: "a", label: "alpha", options: [{ value: "a", label: "alpha", detail: "/profiles/a" }] },
      onChange: () => undefined,
    }));
    const multiple = renderToStaticMarkup(createElement(ComposerProfileTargetControl, {
      busy: false,
      placement: "top",
      state: {
        value: "a",
        label: "alpha",
        options: [
          { value: "a", label: "alpha", detail: "/profiles/a" },
          { value: "b", label: "beta", detail: "/profiles/b" },
        ],
      },
      onChange: () => undefined,
    }));
    expect(one).toBe("");
    expect(multiple).toContain('aria-label="Profile"');
    expect(multiple).toContain("alpha");
  });
});
