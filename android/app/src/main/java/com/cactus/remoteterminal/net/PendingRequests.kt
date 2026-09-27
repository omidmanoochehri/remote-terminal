package com.cactus.remoteterminal.net

/**
 * Requests waiting for their answer, by reqId, each with a deadline. Pure
 * bookkeeping — the owner decides when to [expire] (a timer) and when to
 * [failAll] (the socket dropped) — so the rules are unit tested without a
 * socket: every request is answered exactly once, by its reply, by its
 * deadline, or by the connection going away.
 */
class PendingRequests<T>(private val now: () -> Long = System::currentTimeMillis) {
    private class Entry<T>(val deadline: Long, val callback: (T) -> Unit)

    private val entries = LinkedHashMap<String, Entry<T>>()

    val size: Int get() = entries.size

    /** The earliest deadline still pending, or null when nothing is. */
    val nextDeadline: Long? get() = entries.values.minOfOrNull { it.deadline }

    fun add(reqId: String, timeoutMs: Long, callback: (T) -> Unit) {
        entries[reqId] = Entry(now() + timeoutMs, callback)
    }

    fun has(reqId: String): Boolean = reqId in entries

    /** Deliver [value] to the request [reqId]; false when it is not pending (late, or someone else's). */
    fun complete(reqId: String, value: T): Boolean {
        val e = entries.remove(reqId) ?: return false
        e.callback(value)
        return true
    }

    /** Answer every request past its deadline with [timedOut]; returns how many. */
    fun expire(timedOut: (reqId: String) -> T): Int {
        val t = now()
        val due = entries.filterValues { it.deadline <= t }.keys.toList()
        for (id in due) entries.remove(id)?.callback?.invoke(timedOut(id))
        return due.size
    }

    /** Answer everything still pending with [failure] — the connection is gone. */
    fun failAll(failure: (reqId: String) -> T) {
        val all = entries.toList()
        entries.clear()
        for ((id, e) in all) e.callback(failure(id))
    }
}
