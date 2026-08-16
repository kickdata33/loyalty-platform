/**
 * Channel Adapter interface (FINAL-ARCHITECTURE.md §23). Domain logic never knows about LINE
 * directly — only this interface. `LineAdapter` is the one real implementation in V1; an
 * `EmailAdapter` is explicitly "ในอนาคต" (future, out of scope) per §23.
 */
export interface ChannelAdapter {
  send(params: { merchantId: string; recipientId: string; body: string }): Promise<void>;
}
