import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";

/** R2 bucket holding the uploaded files. */
export const Files = Cloudflare.R2.Bucket("Files");

/** KV namespace holding hashed API keys. */
export const ApiKeys = Cloudflare.KV.Namespace("ApiKeys");

/**
 * The root credential. Generated once on first deploy and kept in alchemy
 * state, so there is no `.env` to manage and nothing to copy between machines
 * — `vpr keys` reads it straight back out of the stack.
 */
export const AdminToken = Alchemy.makeRandom("AdminToken");
