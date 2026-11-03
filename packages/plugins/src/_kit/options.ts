import { z } from "zod";

/** Options schema for plugins that accept no options of their own. */
export const NO_OPTIONS = z.strictObject({});
