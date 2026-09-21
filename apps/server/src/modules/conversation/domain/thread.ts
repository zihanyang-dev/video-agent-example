/** Product ownership and the execution currently visible to its reader. */
export type Thread = {
  threadID: string
  userID: string
  activeTurnID: string | null
}

export type Reader = { userID: string }

// Missing and inaccessible threads have the same public result to avoid disclosing ownership.
export const mayRead = (thread: Thread | null, reader: Reader): thread is Thread =>
  thread !== null && thread.userID === reader.userID
