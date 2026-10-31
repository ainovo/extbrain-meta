import React from "react";

interface Props {
  onClose: () => void;
}

export const TermsModal: React.FC<Props> = ({ onClose }) => {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="ExtBrain Terms of Use and Privacy Notice"
      className="fixed inset-0 z-[60] overflow-y-auto bg-ink/45 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div className="min-h-full flex items-center justify-center p-4">
        <div
          className="w-full max-w-xl rounded-2xl border border-divider bg-canvas shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-5 sm:px-7 py-6 space-y-4">
            <div>
              <h2 className="text-lg sm:text-xl font-bold tracking-tight text-ink leading-tight">
                ExtBrain Terms of Use &amp; Privacy Notice
              </h2>
              <p className="text-[12px] text-mention mt-0.5">
                Last Updated: October 30, 2026
              </p>
              <p className="text-[13px] text-ink leading-relaxed mt-2">
                By installing, accessing, or using ExtBrain, you agree to these
                Terms of Use and Privacy Notice. ExtBrain is provided by Ainovo
                Co. (“we,” “us,” or “our”) in two ways:
              </p>
              <ol type="a" className="text-[13px] text-mention leading-relaxed list-[lower-alpha] pl-5 space-y-1 mt-2 marker:text-ink marker:font-semibold">
                <li>
                  <strong className="text-ink font-semibold">Local Open-Source Software (“Local Version”):</strong>{" "}
                  Self-hosted and installed locally on your machine under the
                  GNU Affero General Public License v3.0 (AGPLv3).
                </li>
                <li>
                  <strong className="text-ink font-semibold">Hosted Web Service (“Hosted Service”):</strong>{" "}
                  Accessed online at extbrain.app.
                </li>
              </ol>
            </div>

            <div className="space-y-3 text-[13px] text-ink leading-relaxed max-h-[55vh] overflow-y-auto sb-scroll pr-1">
              <section>
                <h3 className="font-semibold text-ink">1. What ExtBrain Does</h3>
                <p className="text-mention mt-0.5">
                  <strong className="text-ink font-semibold">1.1</strong>{" "}
                  ExtBrain helps you explore, search, tag, and summarize chat
                  histories and notes you import from third-party services
                  (such as ChatGPT, Gemini, Google Search AI Mode, and
                  Obsidian), and provides an optional interactive voice agent.
                </p>
              </section>

              <section>
                <h3 className="font-semibold text-ink">2. Local Storage &amp; Data Retention (Both Versions)</h3>
                <ol className="mt-0.5 space-y-1.5 list-none pl-0">
                  <li className="text-mention">
                    <strong className="text-ink font-semibold">2.1</strong>{" "}
                    Your imported chat histories, extracted entities, category
                    tags, and application settings are stored locally inside your
                    browser (via IndexedDB/local storage on your device). We do
                    not maintain a central database of your chat archives on our
                    servers.
                  </li>
                  <li className="text-mention">
                    <strong className="text-ink font-semibold">2.2 No Cloud Backup:</strong>{" "}
                    Clearing your browser's site data or cache will permanently
                    delete your stored data in ExtBrain. You are solely
                    responsible for maintaining backups of your original files
                    and important data.
                  </li>
                  <li className="text-mention">
                    <strong className="text-ink font-semibold">2.3 Data Deletion:</strong>{" "}
                    Because your workspace lives in your browser, you can
                    exercise your right to delete your stored data at any time by
                    clearing your browser's site data for ExtBrain.
                  </li>
                </ol>
              </section>

              <section>
                <h3 className="font-semibold text-ink">3. When Data Leaves Your Device &amp; Third-Party Processing</h3>
                <p className="text-mention mt-0.5">
                  <strong className="text-ink font-semibold">3.1</strong>{" "}
                  Depending on which version of ExtBrain you use and which
                  features you trigger, certain data leaves your device for
                  processing:
                </p>
                <ol type="a" className="mt-1.5 space-y-1.5 list-[lower-alpha] pl-5 marker:text-ink marker:font-semibold">
                  <li className="text-mention">
                    <strong className="text-ink font-semibold">If You Use the Local Version (Self-Hosted under AGPLv3):</strong>
                    <ol type="i" className="mt-1 space-y-1 list-[lower-roman] pl-5 marker:text-ink">
                      <li>
                        <strong className="text-ink font-semibold">Entity &amp; Category Tagging:</strong>{" "}
                        Processed 100% locally on your device using embedded models.
                        No chat data leaves your machine for tagging or
                        categorization.
                      </li>
                      <li>
                        <strong className="text-ink font-semibold">Voice Agent &amp; Summaries (Bring Your Own Key):</strong>{" "}
                        To use voice or summary features, you must configure your own
                        Meta model API keys. When triggered, your voice audio,
                        prompts, and selected chat context are sent directly from
                        your instance to Meta's API under your own account and are
                        governed by your direct agreement with Meta.
                      </li>
                    </ol>
                  </li>
                  <li className="text-mention">
                    <strong className="text-ink font-semibold">If You Use the Hosted Service (extbrain.app):</strong>
                    <ol type="i" className="mt-1 space-y-1 list-[lower-roman] pl-5 marker:text-ink">
                      <li>
                        <strong className="text-ink font-semibold">Entity &amp; Category Tagging (via Modal):</strong>{" "}
                        When you import or process chats on extbrain.app, text
                        snippets are transmitted to our cloud inference
                        infrastructure hosted on Modal (Modal Labs, Inc.) to run
                        entity extraction and category tagging models. This data is
                        processed transiently in memory to return your tags and is
                        not stored by us or used to train models.
                      </li>
                      <li>
                        <strong className="text-ink font-semibold">Voice Agent &amp; Summaries (via Meta):</strong>{" "}
                        If you use the voice agent or summary functions on
                        extbrain.app, the content required to fulfill your
                        request — including your voice recordings, transcribed
                        prompts, and the specific chat histories you select — is
                        routed through our server to Meta's model API for
                        transcription and generation. By using the voice or summary
                        features on extbrain.app, you acknowledge and agree that this
                        submitted content may be retained and used by Meta to train
                        and improve Meta's products and AI models. Do not dictate or
                        summarize confidential, proprietary, or sensitive information
                        you are not comfortable sharing for that purpose.
                      </li>
                    </ol>
                  </li>
                </ol>
              </section>

              <section>
                <h3 className="font-semibold text-ink">4. Your Responsibilities &amp; Acceptable Use</h3>
                <ol type="a" className="mt-0.5 space-y-1.5 list-[lower-alpha] pl-5 marker:text-ink marker:font-semibold">
                  <li className="text-mention">
                    <strong className="text-ink font-semibold">Rights to Content:</strong>{" "}
                    You must only import chat histories and files that you have
                    the legal right to use, and you are responsible for complying
                    with the terms of service of the platforms you export from.
                  </li>
                  <li className="text-mention">
                    <strong className="text-ink font-semibold">Sensitive Data:</strong>{" "}
                    Do not import, dictate, or summarize sensitive personal
                    information, protected health/medical records (HIPAA),
                    financial credentials, government IDs, or confidential
                    third-party data — especially when using cloud-connected
                    features on extbrain.app.
                  </li>
                  <li className="text-mention">
                    <strong className="text-ink font-semibold">Age Requirement:</strong>{" "}
                    You must be at least 13 years old (or the minimum legal age
                    of digital consent in your jurisdiction) to use ExtBrain, and
                    at least 18 years old to use features powered by third-party
                    AI APIs.
                  </li>
                </ol>
              </section>

              <section>
                <h3 className="font-semibold text-ink">5. Licensing &amp; Intellectual Property</h3>
                <ol type="a" className="mt-0.5 space-y-1.5 list-[lower-alpha] pl-5 marker:text-ink marker:font-semibold">
                  <li className="text-mention">
                    <strong className="text-ink font-semibold">Your Data:</strong>{" "}
                    You retain all ownership and intellectual property rights to
                    the chat histories and content you import into ExtBrain.
                  </li>
                  <li className="text-mention">
                    <strong className="text-ink font-semibold">Open-Source License:</strong>{" "}
                    The Local Version source code is licensed under the AGPLv3.
                    Your use, modification, and distribution of the source code
                    are governed by the terms of the AGPLv3 license included in
                    the official repository.
                  </li>
                </ol>
              </section>

              <section>
                <h3 className="font-semibold text-ink">6. Disclaimer of Warranties (“As-Is”)</h3>
                <p className="text-mention mt-0.5">
                  <strong className="text-ink font-semibold">6.1</strong>{" "}
                  ExtBrain (both the Local Version and Hosted Service) is
                  provided “AS IS” and “AS AVAILABLE,” without warranties of
                  any kind, whether express, implied, or statutory, including
                  implied warranties of merchantability, fitness for a
                  particular purpose, or non-infringement. AI-generated
                  summaries, entity tags, categories, and voice responses are
                  automated and may be inaccurate, incomplete, or offensive
                  (“hallucinations”). Always verify critical information
                  against your original source chats.
                </p>
              </section>

              <section>
                <h3 className="font-semibold text-ink">7. Limitation of Liability</h3>
                <p className="text-mention mt-0.5">
                  <strong className="text-ink font-semibold">7.1</strong>{" "}
                  To the maximum extent permitted by law, Ainovo Co. and its
                  contributors shall not be liable for any indirect,
                  incidental, special, consequential, or punitive damages, or
                  any loss of data, profits, or privacy arising out of or
                  related to your use of ExtBrain, your clearing of browser
                  storage, or the processing of your data by third-party
                  providers (including Modal and Meta).
                </p>
              </section>

              <section>
                <h3 className="font-semibold text-ink">8. Changes to These Terms &amp; Contact</h3>
                <p className="text-mention mt-0.5">
                  <strong className="text-ink font-semibold">8.1</strong>{" "}
                  We may update these terms from time to time by posting the
                  revised version in the application or repository. Continued
                  use of ExtBrain after changes take effect constitutes your
                  acceptance of the revised terms. For privacy or legal
                  inquiries, please contact us through the official ExtBrain
                  GitHub repository or via extbrain.app.
                </p>
              </section>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-xl bg-action px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-action-hover"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
