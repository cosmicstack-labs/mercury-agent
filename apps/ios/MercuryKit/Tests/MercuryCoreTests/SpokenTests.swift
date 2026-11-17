import Testing
@testable import MercuryCore

struct SpokenTests {
  @Test func markdownIsReadAsPlainSentences() {
    let md = """
    ## Today
    - **Rain** in [Srinagar](https://example.com/news) after noon.
    - Take a `jacket`.

    ```
    curl https://example.com
    ```
    See https://example.com for more.
    """
    #expect(Spoken.text(md) == "Today Rain in Srinagar after noon. Take a jacket. See for more.")
  }

  @Test func shortTextIsOnePart() {
    #expect(Spoken.parts("Hello there.", max: 100) == ["Hello there."])
  }

  @Test func longTextSplitsAtSentenceEnds() {
    let parts = Spoken.parts("One two three. Four five six. Seven.", max: 20)
    #expect(parts == ["One two three.", "Four five six.", "Seven."])
    #expect(parts.allSatisfy { $0.count <= 20 })
  }

  @Test func aSentenceLongerThanAPartSplitsAtSpaces() {
    let parts = Spoken.parts("alpha beta gamma delta epsilon", max: 12)
    #expect(parts == ["alpha beta", "gamma delta", "epsilon"])
  }
}
