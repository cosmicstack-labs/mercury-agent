---
slug: ai-coding-verification-bottleneck
title: "The new bottleneck in AI coding isn't code generation. It's verification."
description: "A Harvard working paper finds coding agents raised code output while review time rose 49%. Why verification, not generation, should decide whether an agent is useful."
authors: [tashiriskhan]
tags: [engineering, news]
image: ./cover.jpg
keywords: [ai coding agents, code review bottleneck, agent verification, ai generated code review, verified completion, coding agent metrics]
draft: false
---

Coding agents are producing substantially more code. Whether that translates into more finished software is less clear.

A 2026 Harvard job-market paper by Fiona Chen and James Stratton studies roughly 300 million work events across 718 firms. After coding-agent adoption, lines of code rose 30%, commits rose 20%, and pull requests rose 23%. The researchers found no statistically significant increase in resolved Jira issues or epics, the proxies they use for software output. The pressure showed up downstream: pull-request review time rose 49%, requests for changes nearly doubled, comments per PR rose 35%, and the share of workers doing code review rose 14%.

{/* truncate */}

The paper identifies code review as the bottleneck. Our broader reading is that code generation is getting cheaper faster than verification is. The study supports the first claim directly. The second is our interpretation, and the rest of this article argues for it.

## Output is the wrong scoreboard

Lines generated, commits, and pull request count are easy to count, and in the study they all went up. None of them shows whether the work is finished. An agent can add 800 lines, declare "done," and hand over code that does not build, was never tested, or breaks a nearby path. Each unverified change moves cost onto a reviewer, who has to rebuild context, find what was skipped, and decide whether the diff is safe.

Review burden is a fair metric, but it needs care. More comments on a large change do not automatically mean worse code. What matters is the total burden a change creates: review time, requested changes, follow-up fixes, and how many people had to step in.

## Better questions for a coding agent

1. **Did it verify its work?** Which build, test, typecheck, or lint commands actually ran, and did they pass? "This should work" is not verification.
2. **How much review burden did it create?** Look at review time, requested changes, follow-up fixes, and reviewer intervention.
3. **Did it catch failures before handing back?** A failure the agent finds is cheaper than the same failure found by a reviewer.
4. **Did it satisfy the task, or only produce valid code?** Code can compile and pass tests while still missing the requirement.

Compiling is not correctness. Passing tests is not the requirement being met. The fourth question is the one most dashboards miss.

## Verification should happen before review

Verification and human review overlap, but they are not the same thing. A reviewer should not have to discover that the project does not compile.

A coding agent should handle:

- build checks
- tests
- type checking
- linting
- obvious runtime failures

Human reviewers should spend their time on:

- architecture and maintainability
- security
- product requirements
- edge cases that automated checks cannot see

The goal is not to remove human review. It is to stop sending reviewers failures a machine could have caught first.

## Why verification is hard to get right

Checks can be made meaningless. An agent may edit a failing test until it matches the new implementation, skip a verification step, or run only a narrow subset of tests that avoids the changed behaviour. The result is a green run that gives false confidence. No intent is needed for this to happen. The check simply stops testing what it claims to test.

So verification should record what ran, what did not, and any change made to the checks themselves. A reviewer should be able to see that a test file was edited in the same change that made it pass.

Passing checks can also be too narrow. A suite that does not cover the changed path proves little, and an agent that reports green without saying what was covered is overstating its result.

## What this means for Mercury

Mercury Code treats completion as something that needs evidence. For implementation tasks, its completion contract requires a build, test, or typecheck command to run and exit cleanly after the last edit before the "Task complete" banner is allowed. If the task cannot finish, Mercury is designed to surface the named blocker and pause, instead of presenting unfinished work as successful. [The completion architecture](https://mercuryagent.sh/docs/reference/completion-architecture) describes the details.

That does not replace human code review. A passing suite cannot judge every architectural trade-off, security implication, or product requirement. The goal is narrower: obvious, machine-detectable failures should reach the agent before they reach the reviewer.

For any coding agent, including Mercury, ask for three things with each change:

- The exact commands run and their results.
- The parts of the change that were not verified.
- Any blocker that stopped the task from finishing.

If an agent cannot give you those, it has produced code, not finished work.

## References

**Primary** (working paper, not yet peer-reviewed)

Fiona Chen and James Stratton, *Artificial Intelligence in the Firm: Bottlenecks in Software Production*, Harvard University, job-market paper, August 2026. [fion.ac/jellyfish.pdf](https://fion.ac/jellyfish.pdf)

**Secondary**

Ars Technica, coverage of the same study. [arstechnica.com](https://arstechnica.com/)
