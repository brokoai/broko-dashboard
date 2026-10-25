import { RuleBasedClassifier, type Classifier, type NormalizedMessage } from "../src/lib/ai-brain";

/** Counts classifications; optionally yields to the event loop so concurrent workers really interleave. */
export class CountingClassifierLike implements Classifier {
  readonly name = "counting";
  calls = 0;
  private readonly inner = new RuleBasedClassifier();
  constructor(private readonly delayMs = 0) {}
  async analyze(msg: NormalizedMessage) {
    this.calls++;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    return this.inner.analyze(msg);
  }
}

/** A schema-valid model answer. */
export const goodAnalysis = () => ({
  requires_action: true, intent: "viewing_request", summary: "Viewing", requested_action: "Arrange", urgency: "normal", urgency_evidence: null, confidence: 0.9,
  contact: { name: null, email: null, phone: null }, property_reference: null, requested_date: null, missing_information: [], risk_flags: [],
  proposed_task: { title: "Arrange viewing", description: "x" }, clarification_question: null,
});
