import express from "express";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { openDb } from "./db.js";
import { createServices, ApiError } from "./services.js";

export function createApp({ db, clock, ttl, sweepIntervalMs = 60_000 } = {}) {
  let ownedDb = db;
  if (!ownedDb) {
    const dbPath = process.env.DB_PATH ?? ".data/muster.db";
    mkdirSync(dirname(dbPath), { recursive: true });
    ownedDb = openDb(dbPath);
  }
  const services = createServices(ownedDb, { clock, ttl });
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.services = services;
  app.db = ownedDb;

  app.get("/health", (_request, response) =>
    response.json({ status: "ok", service: "evacuation-muster" })
  );

  const staffId = (req) => req.header("x-staff-id") || req.body?.staff_id || null;

  // 离线设备同步：(device_id, seq) 幂等
  app.post("/sync", (req, res, next) => {
    try {
      const { device_id, seq, events } = req.body ?? {};
      res.json(services.sync(staffId(req), device_id, seq, events));
    } catch (err) {
      next(err);
    }
  });

  app.post("/reports", (req, res, next) => {
    try {
      res.status(201).json(services.registerReport(staffId(req), req.body ?? {}));
    } catch (err) {
      next(err);
    }
  });

  app.get("/candidates", (req, res, next) => {
    try {
      res.json({ candidates: services.listCandidates(staffId(req)) });
    } catch (err) {
      next(err);
    }
  });

  app.post("/candidates/:candidateId/dismiss", (req, res, next) => {
    try {
      res.json(services.dismissCandidate(staffId(req), req.params.candidateId));
    } catch (err) {
      next(err);
    }
  });

  app.post("/candidates/:candidateId/arrangements", (req, res, next) => {
    try {
      const result = services.openArrangement(staffId(req), req.params.candidateId);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  app.get("/arrangements/:arrangementId", (req, res, next) => {
    try {
      res.json(services.getArrangement(staffId(req), req.params.arrangementId));
    } catch (err) {
      next(err);
    }
  });

  app.post("/arrangements/:arrangementId/confirm", (req, res, next) => {
    try {
      res.json(services.confirmSide(staffId(req), req.params.arrangementId, req.body?.side));
    } catch (err) {
      next(err);
    }
  });

  app.post("/arrangements/:arrangementId/reject", (req, res, next) => {
    try {
      res.json(services.rejectSide(staffId(req), req.params.arrangementId, req.body?.side, req.body?.reason));
    } catch (err) {
      next(err);
    }
  });

  app.get("/reviews", (req, res, next) => {
    try {
      res.json({ arrangements: services.reviewQueue(staffId(req)) });
    } catch (err) {
      next(err);
    }
  });

  app.post("/arrangements/:arrangementId/review", (req, res, next) => {
    try {
      res.json(services.reviewArrangement(staffId(req), req.params.arrangementId, req.body?.decision, req.body?.note));
    } catch (err) {
      next(err);
    }
  });

  app.get("/arrangements/:arrangementId/credential", (req, res, next) => {
    try {
      res.json(services.getCredential(staffId(req), req.params.arrangementId));
    } catch (err) {
      next(err);
    }
  });

  app.post("/arrangements/:arrangementId/complete", (req, res, next) => {
    try {
      res.json(services.completeArrangement(staffId(req), req.params.arrangementId));
    } catch (err) {
      next(err);
    }
  });

  app.post("/restrictions", (req, res, next) => {
    try {
      res.status(201).json(services.addRestriction(staffId(req), req.body ?? {}));
    } catch (err) {
      next(err);
    }
  });

  app.post("/reports/:reportId/transfer", (req, res, next) => {
    try {
      res.json(services.applyTransfer(staffId(req), req.params.reportId, req.body ?? {}));
    } catch (err) {
      next(err);
    }
  });

  app.post("/reports/:reportId/evac-correction", (req, res, next) => {
    try {
      res.json(services.applyEvacCorrection(staffId(req), req.params.reportId, req.body ?? {}));
    } catch (err) {
      next(err);
    }
  });

  app.get("/command/summary", (req, res, next) => {
    try {
      res.json(services.commandSummary(staffId(req)));
    } catch (err) {
      next(err);
    }
  });

  app.get("/audit/reconstruction", (req, res, next) => {
    try {
      res.json(
        services.auditReconstruct(staffId(req), {
          arrangement_id: req.query.arrangement_id || null,
          report_id: req.query.report_id || null,
        })
      );
    } catch (err) {
      next(err);
    }
  });

  app.use((err, _req, res, _next) => {
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: err.code, message: err.message });
    } else if (err?.type === "entity.parse.failed") {
      res.status(400).json({ error: "bad_json", message: "请求体不是合法 JSON" });
    } else {
      res.status(500).json({ error: "internal_error", message: "服务内部错误" });
      // eslint-disable-next-line no-console
      console.error(err);
    }
  });

  // 启动与定时扫描：重启后按墙上时间继续凭据有效期与确认截止
  services.sweepTimeouts();
  const timer = sweepIntervalMs
    ? setInterval(() => services.sweepTimeouts(), sweepIntervalMs)
    : null;
  if (timer?.unref) timer.unref();

  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8080);
  createApp().listen(port, "0.0.0.0");
}
