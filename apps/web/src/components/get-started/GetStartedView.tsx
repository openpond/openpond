import { ExternalLink } from "../icons";
import { publicVideoUrl } from "../../lib/public-video-assets";
import "../../styles/get-started/get-started-links.css";

type VideoLink = {
  description: string;
  duration: string;
  href: string;
  title: string;
};

type VideoSection = {
  description: string;
  links: readonly VideoLink[];
  title: string;
};

const VIDEO_SECTIONS: readonly VideoSection[] = [
  {
    title: "OpenPond overview",
    description: "A short introduction to agents, actions, runtime surfaces, and evals.",
    links: [
      {
        title: "What is an OpenPond Agent?",
        description: "See how Profile Agents work across chat, actions, and evals.",
        duration: "1:16",
        href: publicVideoUrl("openpond-agent-overview"),
      },
    ],
  },
  {
    title: "Build an agent",
    description: "Watch the complete walkthrough or jump directly to one chapter.",
    links: [
      {
        title: "How to make an agent",
        description: "Create, use, and improve an Account Health Agent.",
        duration: "4:33",
        href: publicVideoUrl("make-agent-tutorial"),
      },
      {
        title: "Create an Agent",
        description: "Turn a concrete workflow into an agent.",
        duration: "1:40",
        href: publicVideoUrl("make-agent-tutorial-create"),
      },
      {
        title: "Use the Agent",
        description: "Run the agent from the OpenPond interface.",
        duration: "1:15",
        href: publicVideoUrl("make-agent-tutorial-use"),
      },
      {
        title: "Improve the Agent",
        description: "Review its results and iterate on the source.",
        duration: "1:49",
        href: publicVideoUrl("make-agent-tutorial-improve"),
      },
    ],
  },
  {
    title: "Post-training from first principles",
    description: "The complete course and its individual lessons.",
    links: [
      {
        title: "Full course",
        description: "All ten lessons in one continuous video.",
        duration: "29:20",
        href: publicVideoUrl("post-training-full-course"),
      },
      {
        title: "1. How post-training works",
        description: "The choose, judge, and update loop behind post-training.",
        duration: "1:05",
        href: publicVideoUrl("post-training-01-how-post-training-works"),
      },
      {
        title: "2. Definitions",
        description: "Policy notation, rollouts, advantages, gradients, and GRPO.",
        duration: "6:14",
        href: publicVideoUrl("post-training-02-definitions"),
      },
      {
        title: "3. On-policy and off-policy data",
        description: "How learner rollouts differ from teacher or stored data.",
        duration: "1:06",
        href: publicVideoUrl("post-training-03-on-policy-off-policy"),
      },
      {
        title: "4. Rewards and credit assignment",
        description: "Follow a trajectory from actions to advantage.",
        duration: "3:00",
        href: publicVideoUrl("post-training-04-rewards-credit-assignment"),
      },
      {
        title: "5. Verifiable rewards",
        description: "How tests create scalable rewards and where they fail.",
        duration: "2:53",
        href: publicVideoUrl("post-training-05-verifiable-rewards-rlvr"),
      },
      {
        title: "6. PPO and GRPO",
        description: "Compare learned critics with sibling-response baselines.",
        duration: "2:54",
        href: publicVideoUrl("post-training-06-ppo-grpo"),
      },
      {
        title: "7. Distillation",
        description: "Transfer a teacher's token distribution.",
        duration: "2:42",
        href: publicVideoUrl("post-training-07-distillation"),
      },
      {
        title: "8. OPSD, SDFT, and SDPO",
        description: "Compare trusted solutions, demonstrations, and feedback.",
        duration: "2:43",
        href: publicVideoUrl("post-training-08-opsd-sdft-sdpo"),
      },
      {
        title: "9. Credible experiments",
        description: "Build fair baselines and claims that survive scrutiny.",
        duration: "3:32",
        href: publicVideoUrl("post-training-09-credible-experiments"),
      },
      {
        title: "10. Technical appendix",
        description: "Advanced details for GRPO, teacher logits, and sample routing.",
        duration: "3:12",
        href: publicVideoUrl("post-training-10-technical-appendix"),
      },
    ],
  },
];

export function GetStartedView() {
  return (
    <main className="get-started-view">
      <div className="get-started-links">
        <header className="get-started-links-header">
          <h1>Videos</h1>
          <p>Choose a walkthrough to open it in a new tab.</p>
        </header>

        {VIDEO_SECTIONS.map((section) => (
          <section className="get-started-link-section" key={section.title}>
            <header>
              <h2>{section.title}</h2>
              <p>{section.description}</p>
            </header>
            <div className="get-started-link-list">
              {section.links.map((video) => (
                <a
                  className="get-started-video-link"
                  href={video.href}
                  key={video.href}
                  rel="noreferrer"
                  target="_blank"
                >
                  <span className="get-started-video-copy">
                    <strong>{video.title}</strong>
                    <span>{video.description}</span>
                  </span>
                  <span className="get-started-video-meta">
                    <span>{video.duration}</span>
                    <ExternalLink aria-hidden="true" size={15} />
                  </span>
                </a>
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
