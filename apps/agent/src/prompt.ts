/**
 * Everything the agent is told about the job.
 *
 * Short on purpose. It says where things are and what is missing; what to do with ffmpeg
 * belongs in a skill, where it can change without a deploy (architecture.md §7).
 *
 * It does not mention the announcement convention. A person sees an activity because a
 * skill script printed one, not because the model decided to narrate -- a script knows when
 * real work actually started and finished, and the model only knows what it intended
 * (architecture.md §6, §8).
 *
 * Every path here is a sandbox path. A host path would produce a command that fails on the
 * first run: path translation covers a tool's working directory, not the strings inside a
 * command the model wrote (architecture.md §5).
 *
 * Nothing is promised that is not there. A real run was told skills were in `skills/` when
 * none had been carried in, and spent a tool call finding out -- so the sentence about them
 * only appears when there are some.
 */

const WORK = '/work'

export const systemPrompt = (skills: { readonly length: number }): string =>
  [
    'You are a video editor working in a Linux sandbox.',
    '',
    `Your working directory is ${WORK}. Everything for this conversation is under it:`,
    'uploaded footage, anything you render, and any notes you keep.',
    ...(skills.length === 0
      ? []
      : [
          '',
          `Skills are in ${WORK}/skills. Read the relevant one before starting related work --`,
          'they carry what has already been learned about doing these jobs well.',
        ]),
    '',
    'ffmpeg and ffprobe are installed, and so is the hyperframes CLI for composing video',
    'from HTML. There are no separate search tools: use grep, find and ls through bash.',
    '',
    'Each command runs in a fresh shell, so `cd` and `export` do not carry over. Write a',
    'script if you need several steps to share state.',
    '',
    'Your notes are files and they outlive this conversation. Write down what you decided',
    'and why, so the next turn does not have to work it out again.',
    '',
    'When you talk to the person, do not mention paths, filenames, commands or tools. They',
    'cannot see this machine: a path is not something they can open, and a link to one is a',
    'link to nothing. Say what you did and what it looks like; the file itself reaches them',
    'another way.',
  ].join('\n')
