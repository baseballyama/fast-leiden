// fast-leiden — native binding.
//
// Exposes five N-API functions:
//
//   - version():                  addon version string (smoke test)
//   - leidenFromEdgeList():       sync edge-list entry point
//   - leidenFromCsr():            sync CSR entry point
//   - leidenFromEdgeListAsync():  same, but runs on a worker thread,
//                                 returns a Promise
//   - leidenFromCsrAsync():       same for CSR
//
// All four leiden* functions accept the same options object on the JS side
// and return (resolve to) { membership: Uint32Array, quality: number,
// iterations: number }.

#include <napi.h>

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include <igraph/igraph.h>
#include <CPMVertexPartition.h>
#include <GraphHelper.h>
#include <ModularityVertexPartition.h>
#include <Optimiser.h>

namespace {

constexpr const char* kAddonVersion = "0.0.1";

// ---------------------------------------------------------------------------
// Small RAII helpers.

class IgraphGuard {
 public:
  explicit IgraphGuard(igraph_t* g) : g_(g) {}
  ~IgraphGuard() {
    if (g_) igraph_destroy(g_);
  }
  IgraphGuard(const IgraphGuard&) = delete;
  IgraphGuard& operator=(const IgraphGuard&) = delete;

 private:
  igraph_t* g_;
};

class IgraphVectorIntGuard {
 public:
  explicit IgraphVectorIntGuard(igraph_vector_int_t* v) : v_(v) {}
  ~IgraphVectorIntGuard() {
    if (v_) igraph_vector_int_destroy(v_);
  }
  IgraphVectorIntGuard(const IgraphVectorIntGuard&) = delete;
  IgraphVectorIntGuard& operator=(const IgraphVectorIntGuard&) = delete;

 private:
  igraph_vector_int_t* v_;
};

// ---------------------------------------------------------------------------
// Owned representation of a Leiden call. Holds copies of all input arrays so
// that worker threads can safely operate on them after the JS call returns.

struct LeidenJob {
  uint32_t node_count = 0;
  std::vector<uint32_t> sources;
  std::vector<uint32_t> targets;
  std::vector<double> weights;
  bool has_weights = false;

  // Options.
  std::string quality_function = "modularity";
  double resolution = 1.0;
  int max_iterations = 10;
  bool has_seed = false;
  uint32_t seed = 0;
  bool directed = false;
};

struct LeidenResultC {
  std::vector<size_t> membership;
  double quality = 0.0;
  int iterations = 0;
};

// ---------------------------------------------------------------------------
// Pure C++ work — no Napi access. Safe to call from a worker thread.

void BuildIgraphFromEdges(igraph_t* g,
                          uint32_t node_count,
                          const uint32_t* sources,
                          const uint32_t* targets,
                          size_t edge_count,
                          bool directed) {
  igraph_vector_int_t edges;
  if (igraph_vector_int_init(&edges, static_cast<igraph_int_t>(2 * edge_count)) !=
      IGRAPH_SUCCESS) {
    throw std::runtime_error("igraph_vector_int_init failed");
  }
  IgraphVectorIntGuard edges_guard(&edges);

  for (size_t i = 0; i < edge_count; ++i) {
    if (sources[i] >= node_count || targets[i] >= node_count) {
      throw std::runtime_error("edge endpoint is out of range [0, nodeCount)");
    }
    VECTOR(edges)[2 * i] = static_cast<igraph_int_t>(sources[i]);
    VECTOR(edges)[2 * i + 1] = static_cast<igraph_int_t>(targets[i]);
  }

  if (igraph_create(g, &edges, static_cast<igraph_int_t>(node_count),
                    directed ? IGRAPH_DIRECTED : IGRAPH_UNDIRECTED) !=
      IGRAPH_SUCCESS) {
    throw std::runtime_error("igraph_create failed");
  }
}

LeidenResultC RunLeidenOnGraph(Graph& graph, const LeidenJob& job) {
  std::unique_ptr<MutableVertexPartition> partition;
  if (job.quality_function == "modularity") {
    partition.reset(new ModularityVertexPartition(&graph));
  } else if (job.quality_function == "cpm") {
    partition.reset(new CPMVertexPartition(&graph, job.resolution));
  } else {
    throw std::runtime_error("unknown qualityFunction: " + job.quality_function);
  }

  Optimiser optimiser;
  if (job.has_seed) {
    optimiser.set_rng_seed(static_cast<size_t>(job.seed));
  }

  // The Leiden algorithm in libleidenalg is itself iterative inside one
  // optimise_partition() call; the outer loop here mirrors leidenalg's
  // Python `n_iterations` parameter — re-running optimise_partition often
  // squeezes out another improvement, until it returns 0 (converged).
  int iterations_run = 0;
  for (int i = 0; i < job.max_iterations; ++i) {
    double improvement = optimiser.optimise_partition(partition.get());
    ++iterations_run;
    if (improvement <= 0.0) break;
  }

  return LeidenResultC{
      partition->membership(),
      partition->quality(),
      iterations_run,
  };
}

LeidenResultC RunLeidenJob(const LeidenJob& job) {
  const size_t edge_count = job.sources.size();
  igraph_t g;
  BuildIgraphFromEdges(&g, job.node_count, job.sources.data(), job.targets.data(),
                       edge_count, job.directed);
  IgraphGuard g_guard(&g);

  std::unique_ptr<Graph> graph(
      job.has_weights ? Graph::GraphFromEdgeWeights(&g, job.weights) : new Graph(&g));
  return RunLeidenOnGraph(*graph, job);
}

// ---------------------------------------------------------------------------
// JS -> LeidenJob conversion. Validates and copies TypedArrays into vectors
// owned by the job so we can hand them off to a worker thread safely.

void ApplyOptions(Napi::Object& obj, LeidenJob& job) {
  Napi::Value q = obj.Get("qualityFunction");
  if (q.IsString()) {
    job.quality_function = q.As<Napi::String>().Utf8Value();
  }
  Napi::Value res = obj.Get("resolution");
  if (res.IsNumber()) {
    job.resolution = res.As<Napi::Number>().DoubleValue();
  }
  Napi::Value mi = obj.Get("maxIterations");
  if (mi.IsNumber()) {
    job.max_iterations = mi.As<Napi::Number>().Int32Value();
  }
  Napi::Value seed = obj.Get("seed");
  if (seed.IsNumber()) {
    job.has_seed = true;
    job.seed = seed.As<Napi::Number>().Uint32Value();
  }
  Napi::Value dir = obj.Get("directed");
  if (dir.IsBoolean()) {
    job.directed = dir.As<Napi::Boolean>().Value();
  }
}

// Returns true on success, false on validation failure (in which case a JS
// exception is already pending and the caller should return Undefined()).
bool ReadEdgeListJob(Napi::Env env, Napi::Object input, LeidenJob& job) {
  if (!input.Get("nodeCount").IsNumber()) {
    Napi::TypeError::New(env, "nodeCount must be a number").ThrowAsJavaScriptException();
    return false;
  }
  job.node_count = input.Get("nodeCount").As<Napi::Number>().Uint32Value();

  Napi::Value sv = input.Get("sources");
  Napi::Value tv = input.Get("targets");
  if (!sv.IsTypedArray() || !tv.IsTypedArray()) {
    Napi::TypeError::New(env, "sources and targets must be Uint32Array")
        .ThrowAsJavaScriptException();
    return false;
  }
  Napi::Uint32Array sources = sv.As<Napi::Uint32Array>();
  Napi::Uint32Array targets = tv.As<Napi::Uint32Array>();
  if (sources.ElementLength() != targets.ElementLength()) {
    Napi::RangeError::New(env, "sources and targets must have equal length")
        .ThrowAsJavaScriptException();
    return false;
  }
  const size_t edge_count = sources.ElementLength();
  job.sources.assign(sources.Data(), sources.Data() + edge_count);
  job.targets.assign(targets.Data(), targets.Data() + edge_count);

  Napi::Value wv = input.Get("weights");
  if (!wv.IsUndefined() && !wv.IsNull()) {
    if (!wv.IsTypedArray()) {
      Napi::TypeError::New(env, "weights must be a Float64Array").ThrowAsJavaScriptException();
      return false;
    }
    Napi::Float64Array weights = wv.As<Napi::Float64Array>();
    if (weights.ElementLength() != edge_count) {
      Napi::RangeError::New(env, "weights length must match edge count")
          .ThrowAsJavaScriptException();
      return false;
    }
    job.weights.assign(weights.Data(), weights.Data() + edge_count);
    job.has_weights = true;
  }

  ApplyOptions(input, job);
  return true;
}

bool ReadCsrJob(Napi::Env env, Napi::Object input, LeidenJob& job) {
  if (!input.Get("nodeCount").IsNumber()) {
    Napi::TypeError::New(env, "nodeCount must be a number").ThrowAsJavaScriptException();
    return false;
  }
  job.node_count = input.Get("nodeCount").As<Napi::Number>().Uint32Value();

  Napi::Value ov = input.Get("offsets");
  Napi::Value tv = input.Get("targets");
  if (!ov.IsTypedArray() || !tv.IsTypedArray()) {
    Napi::TypeError::New(env, "offsets and targets must be Uint32Array")
        .ThrowAsJavaScriptException();
    return false;
  }
  Napi::Uint32Array offsets = ov.As<Napi::Uint32Array>();
  Napi::Uint32Array targets = tv.As<Napi::Uint32Array>();

  if (offsets.ElementLength() != static_cast<size_t>(job.node_count) + 1) {
    Napi::RangeError::New(env, "offsets length must be nodeCount + 1")
        .ThrowAsJavaScriptException();
    return false;
  }
  const uint32_t* offsets_data = offsets.Data();
  const uint32_t edge_count = offsets_data[job.node_count];
  if (targets.ElementLength() != edge_count) {
    Napi::RangeError::New(env, "targets length must match offsets[-1]")
        .ThrowAsJavaScriptException();
    return false;
  }

  job.targets.assign(targets.Data(), targets.Data() + edge_count);
  job.sources.resize(edge_count);
  for (uint32_t v = 0; v < job.node_count; ++v) {
    const uint32_t start = offsets_data[v];
    const uint32_t end = offsets_data[v + 1];
    for (uint32_t e = start; e < end; ++e) {
      job.sources[e] = v;
    }
  }

  Napi::Value wv = input.Get("weights");
  if (!wv.IsUndefined() && !wv.IsNull()) {
    if (!wv.IsTypedArray()) {
      Napi::TypeError::New(env, "weights must be a Float64Array").ThrowAsJavaScriptException();
      return false;
    }
    Napi::Float64Array weights = wv.As<Napi::Float64Array>();
    if (weights.ElementLength() != edge_count) {
      Napi::RangeError::New(env, "weights length must match edge count")
          .ThrowAsJavaScriptException();
      return false;
    }
    job.weights.assign(weights.Data(), weights.Data() + edge_count);
    job.has_weights = true;
  }

  ApplyOptions(input, job);
  return true;
}

Napi::Object BuildResultObject(Napi::Env env, const LeidenResultC& result) {
  Napi::Object out = Napi::Object::New(env);

  const size_t n = result.membership.size();
  Napi::Uint32Array membership = Napi::Uint32Array::New(env, n);
  uint32_t* data = membership.Data();
  for (size_t i = 0; i < n; ++i) {
    data[i] = static_cast<uint32_t>(result.membership[i]);
  }

  out.Set("membership", membership);
  out.Set("quality", Napi::Number::New(env, result.quality));
  out.Set("iterations", Napi::Number::New(env, static_cast<double>(result.iterations)));
  return out;
}

// ---------------------------------------------------------------------------
// AsyncWorker for the non-blocking variants.

class LeidenAsyncWorker : public Napi::AsyncWorker {
 public:
  LeidenAsyncWorker(Napi::Env env,
                    Napi::Promise::Deferred deferred,
                    LeidenJob&& job)
      : Napi::AsyncWorker(env), deferred_(deferred), job_(std::move(job)) {}

  void Execute() override {
    try {
      result_ = RunLeidenJob(job_);
    } catch (const std::exception& e) {
      SetError(e.what());
    } catch (...) {
      SetError("unknown C++ exception in Leiden worker");
    }
  }

  void OnOK() override {
    Napi::HandleScope scope(Env());
    deferred_.Resolve(BuildResultObject(Env(), result_));
  }

  void OnError(const Napi::Error& e) override {
    Napi::HandleScope scope(Env());
    deferred_.Reject(e.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  LeidenJob job_;
  LeidenResultC result_;
};

// ---------------------------------------------------------------------------
// JS entry points.

Napi::Value Version(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), kAddonVersion);
}

Napi::Value LeidenFromEdgeList(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "expected an options object").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Object input = info[0].As<Napi::Object>();
  LeidenJob job;
  if (!ReadEdgeListJob(env, input, job)) return env.Undefined();
  try {
    return BuildResultObject(env, RunLeidenJob(job));
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

Napi::Value LeidenFromCsrJs(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "expected an options object").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Object input = info[0].As<Napi::Object>();
  LeidenJob job;
  if (!ReadCsrJob(env, input, job)) return env.Undefined();
  try {
    return BuildResultObject(env, RunLeidenJob(job));
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

Napi::Value LeidenFromEdgeListAsync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto deferred = Napi::Promise::Deferred::New(env);
  if (info.Length() < 1 || !info[0].IsObject()) {
    deferred.Reject(Napi::TypeError::New(env, "expected an options object").Value());
    return deferred.Promise();
  }
  Napi::Object input = info[0].As<Napi::Object>();
  LeidenJob job;
  if (!ReadEdgeListJob(env, input, job)) {
    // ReadEdgeListJob threw a JS exception synchronously; convert that into a
    // promise rejection so callers get consistent error-handling semantics.
    Napi::Error pending = env.GetAndClearPendingException();
    deferred.Reject(pending.Value());
    return deferred.Promise();
  }
  auto* worker = new LeidenAsyncWorker(env, deferred, std::move(job));
  worker->Queue();
  return deferred.Promise();
}

Napi::Value LeidenFromCsrAsync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto deferred = Napi::Promise::Deferred::New(env);
  if (info.Length() < 1 || !info[0].IsObject()) {
    deferred.Reject(Napi::TypeError::New(env, "expected an options object").Value());
    return deferred.Promise();
  }
  Napi::Object input = info[0].As<Napi::Object>();
  LeidenJob job;
  if (!ReadCsrJob(env, input, job)) {
    Napi::Error pending = env.GetAndClearPendingException();
    deferred.Reject(pending.Value());
    return deferred.Promise();
  }
  auto* worker = new LeidenAsyncWorker(env, deferred, std::move(job));
  worker->Queue();
  return deferred.Promise();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("version", Napi::Function::New(env, Version));
  exports.Set("leidenFromEdgeList", Napi::Function::New(env, LeidenFromEdgeList));
  exports.Set("leidenFromCsr", Napi::Function::New(env, LeidenFromCsrJs));
  exports.Set("leidenFromEdgeListAsync",
              Napi::Function::New(env, LeidenFromEdgeListAsync));
  exports.Set("leidenFromCsrAsync", Napi::Function::New(env, LeidenFromCsrAsync));
  return exports;
}

}  // namespace

NODE_API_MODULE(fast_leiden, Init)
