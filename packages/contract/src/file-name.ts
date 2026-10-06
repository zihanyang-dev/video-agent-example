import { z } from 'zod'

export const fileNameSchema = z
  .string()
  .min(1)
  .max(255)
  // No /u flag: the bound must count UTF-16 units, not Unicode code points.
  .regex(
    // oxlint-disable-next-line no-control-regex -- The filename boundary must reject ASCII controls.
    /^(?!\.{1,2}$)[^/\\\u0000-\u001f\u007f]{1,255}$/,
    'File names must be 1–255 UTF-16 code units, not dot names or paths, and cannot contain ASCII controls',
  )
  .describe(
    'File name, not a path. Length is measured in UTF-16 code units at runtime; foreign validators may count Unicode code points.',
  )
