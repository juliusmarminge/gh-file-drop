import * as Cloudflare from "alchemy/Cloudflare";

/** R2 bucket holding the uploaded files. */
export const Files = Cloudflare.R2.Bucket("Files");

/** KV namespace holding hashed API keys. */
export const ApiKeys = Cloudflare.KV.Namespace("ApiKeys");
