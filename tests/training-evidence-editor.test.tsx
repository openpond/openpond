import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, test } from "vitest";
import {
  buildSpecificationReady,
  emptyBuildSpecification,
  TrainingEvidenceEditor,
} from "../apps/web/src/components/training/TrainingEvidenceEditor";
import { TrainingStartModeStep } from "../apps/web/src/components/training/TrainingStartModeStep";

describe("Training evidence editor", () => {
  test("evidence cards support arrow-key radio navigation", () => {
    const changes: string[] = [];
    const tree = TrainingStartModeStep({
      mode: "demonstrations",
      targetLabel: "dataset",
      onChange: (value) => changes.push(value),
      onContinue: () => undefined,
    });
    const buttons = elements(tree).filter((element) => element.props.role === "radio");
    let focused = false;
    buttons[0]!.props.onKeyDown({
      key: "ArrowRight",
      preventDefault: () => undefined,
      currentTarget: {
        parentElement: {
          querySelectorAll: () => buttons.map((_button, index) => ({
            focus: () => { if (index === 1) focused = true; },
          })),
        },
      },
    });

    expect(changes).toEqual(["preferences"]);
    expect(focused).toBe(true);
  });

  test.each([
    ["demonstrations", "Demonstration evidence", "Add example"],
    ["preferences", "Preference evidence", "Add comparison"],
    ["verifiable_reward", "Verifiable reward evidence", "Add reward rule"],
    ["rubric", "Rubric evidence", "Add criterion"],
  ] as const)("renders the %s editor", (intent, ariaLabel, action) => {
    const html = renderToStaticMarkup(
      <TrainingEvidenceEditor
        disabled={false}
        specification={emptyBuildSpecification(intent)}
        onChange={() => undefined}
      />,
    );

    expect(html).toContain(`aria-label="${ariaLabel}"`);
    expect(html).toContain(action);
  });

  test("requires a real demonstration or selected chat in addition to the behavior", () => {
    const empty = emptyBuildSpecification("demonstrations");
    expect(buildSpecificationReady(empty)).toBe(false);
    expect(buildSpecificationReady({
      ...empty,
      behavior: "Answer SQL questions with valid executable queries.",
    })).toBe(true);
  });

  test("requires reward rules and rubric calibration fixtures", () => {
    const reward = emptyBuildSpecification("verifiable_reward");
    expect(buildSpecificationReady({ ...reward, task: "Produce valid SQL." })).toBe(false);
    expect(buildSpecificationReady({
      ...reward,
      task: "Produce valid SQL.",
      rules: [{ id: "executes", points: 1, condition: "The query executes." }],
    })).toBe(true);

    const rubric = emptyBuildSpecification("rubric");
    expect(buildSpecificationReady({
      ...rubric,
      task: "Review the answer.",
      criteria: [{ id: "grounded", label: "Grounded", description: "Every claim is supported." }],
      positiveExample: "All claims cite the supplied context.",
      negativeExample: "The response invents a source.",
      boundaryExample: "The response is correct but misses one citation.",
    })).toBe(true);
  });
});

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  return [
    element,
    ...elements((element.props as { children?: ReactNode }).children),
  ];
}
