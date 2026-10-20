// lanework-dictation (FE-69): speech to text for the composer, on the Mac.
//
// Spawned by main (`electron/main/dictation/`), one process per dictation. It
// opens the microphone itself, so the renderer never gets `media` permission
// (FE-69/D8), and transcribes with Apple's DictationTranscriber — the only
// on-device engine of SpeechAnalyzer that has Vietnamese (`SpeechTranscriber`
// does not, as of macOS 26/27).
//
// Protocol: one JSON object per line on stdout —
//   {"type":"preparing"}                       language assets downloading
//   {"type":"listening"}                       the microphone is open
//   {"type":"level","value":0.42}              ~20 per second, 0…1
//   {"type":"text","final":"…","volatile":"…"} what has been heard so far
//   {"type":"done","text":"…"}                 after "stop", then exit 0
//   {"type":"error","code":"…","message":"…"}  then exit 1
// and one command per line on stdin: `stop` (finish what was said) or
// `cancel` (exit now). EOF on stdin — main went away — is a cancel.
//
// Usage: lanework-dictation --locale vi_VN [--hint word]... [--file a.wav]
// `--file` reads a recording instead of the microphone, for checking by hand.

import AVFoundation
import Foundation
import Speech

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object),
    let line = String(data: data, encoding: .utf8)
  else { return }
  print(line)
}

func fail(_ code: String, _ message: String) -> Never {
  emit(["type": "error", "code": code, "message": message])
  exit(1)
}

var localeId = "vi_VN"
var hints: [String] = []
var file: String?
var args = CommandLine.arguments.dropFirst().makeIterator()
while let arg = args.next() {
  switch arg {
  case "--locale": localeId = args.next() ?? localeId
  case "--hint": if let hint = args.next() { hints.append(hint) }
  case "--file": file = args.next()
  default: fail("usage", "Unknown argument \(arg)")
  }
}

/// A meter reading as a bar's height: linear amplitude above a -60 dB floor,
/// square-rooted so speech fills the bars rather than peaking.
func level(_ buffer: AVAudioPCMBuffer) -> Double {
  guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
  var sum: Float = 0
  for index in 0..<Int(buffer.frameLength) { sum += samples[index] * samples[index] }
  let rms = Double(sqrt(sum / Float(buffer.frameLength)))
  let floor = pow(10, -60.0 / 20)
  guard rms > floor else { return 0 }
  return min(1, sqrt((rms - floor) / (1 - floor)))
}

@available(macOS 26.0, *)
final class Dictation: @unchecked Sendable {
  let engine = AVAudioEngine()
  var input: AsyncStream<AnalyzerInput>.Continuation?
  var analyzer: SpeechAnalyzer?
  var results: Task<String, Error>?
  var stopping = false

  func run() async {
    guard
      let locale = await DictationTranscriber.supportedLocale(
        equivalentTo: Locale(identifier: localeId))
    else { fail("unsupported", "This Mac cannot transcribe \(localeId).") }

    if file == nil {
      switch AVCaptureDevice.authorizationStatus(for: .audio) {
      case .authorized: break
      case .notDetermined:
        if !(await AVCaptureDevice.requestAccess(for: .audio)) {
          fail("microphone-denied", "Lanework is not allowed to use the microphone.")
        }
      default: fail("microphone-denied", "Lanework is not allowed to use the microphone.")
      }
    }

    let transcriber = DictationTranscriber(locale: locale, preset: .progressiveLongDictation)
    do {
      if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        emit(["type": "preparing"])
        try await request.downloadAndInstall()
      }
    } catch { fail("assets", "Could not download the speech model: \(error.localizedDescription)") }

    let analyzer = SpeechAnalyzer(modules: [transcriber])
    self.analyzer = analyzer
    if !hints.isEmpty {
      let context = AnalysisContext()
      context.contextualStrings[.general] = hints
      try? await analyzer.setContext(context)
    }

    // Finalised text accumulates; the volatile tail is replaced each time.
    results = Task {
      var final = ""
      for try await result in transcriber.results {
        let text = String(result.text.characters)
        if result.isFinal {
          final += text
          emit(["type": "text", "final": final, "volatile": ""])
        } else {
          emit(["type": "text", "final": final, "volatile": text])
        }
      }
      return final
    }

    do {
      if let file {
        let audio = try AVAudioFile(forReading: URL(fileURLWithPath: file))
        emit(["type": "listening"])
        try await analyzer.start(inputAudioFile: audio, finishAfterFile: true)
        finish(try await results!.value)
      }
      try await listen(transcriber, analyzer)
    } catch {
      fail("engine", error.localizedDescription)
    }
  }

  func listen(_ transcriber: DictationTranscriber, _ analyzer: SpeechAnalyzer) async throws {
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
    else { fail("engine", "No audio format the transcriber accepts.") }
    let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
    input = continuation
    try await analyzer.start(inputSequence: stream)

    let node = engine.inputNode
    let native = node.outputFormat(forBus: 0)
    guard native.sampleRate > 0, let converter = AVAudioConverter(from: native, to: format)
    else { fail("microphone", "No microphone is available.") }
    var lastLevel = Date.distantPast
    node.installTap(onBus: 0, bufferSize: 1024, format: native) { buffer, _ in
      let now = Date()
      if now.timeIntervalSince(lastLevel) >= 0.05 {
        lastLevel = now
        emit(["type": "level", "value": (level(buffer) * 100).rounded() / 100])
      }
      let ratio = format.sampleRate / native.sampleRate
      let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1
      guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
      var fed = false
      var error: NSError?
      converter.convert(to: converted, error: &error) { _, status in
        if fed {
          status.pointee = .noDataNow
          return nil
        }
        fed = true
        status.pointee = .haveData
        return buffer
      }
      if error == nil, converted.frameLength > 0 { continuation.yield(AnalyzerInput(buffer: converted)) }
    }
    engine.prepare()
    try engine.start()
    emit(["type": "listening"])
  }

  /// `stop`: close the microphone, let the transcriber finish what it heard.
  func stop() async {
    if stopping { return }
    stopping = true
    engine.stop()
    engine.inputNode.removeTap(onBus: 0)
    input?.finish()
    do {
      try await analyzer?.finalizeAndFinishThroughEndOfInput()
      finish(try await results?.value ?? "")
    } catch { fail("engine", error.localizedDescription) }
  }

  func finish(_ text: String) -> Never {
    emit(["type": "done", "text": text.trimmingCharacters(in: .whitespacesAndNewlines)])
    exit(0)
  }
}

guard #available(macOS 26.0, *) else { fail("unsupported", "Dictation needs macOS 26 or later.") }
let dictation = Dictation()

// Commands arrive on stdin; EOF means main is gone, so nothing is left to hear.
Thread.detachNewThread {
  while let line = readLine() {
    switch line.trimmingCharacters(in: .whitespaces) {
    case "stop": Task { await dictation.stop() }
    case "cancel": exit(0)
    default: continue
    }
  }
  exit(0)
}

Task { await dictation.run() }
dispatchMain()
