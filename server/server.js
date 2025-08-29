import express from "express";
import cors from "cors";
import { nanoid } from "nanoid";
import Database from "better-sqlite3";
import fs from "fs";

const PORT = process.env.PORT || 3000;
const ORIGIN = process.env.ORIGIN || "*";
const DB_FILE = process.env.DATABASE_FILE || "./data.sqlite";

const app = express();
app.use(express.json({ limit:"1mb" }));
app.use(cors({ origin: ORIGIN==="*" ? true : ORIGIN.split(","), credentials:false }));

// --- DB setup ---
const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS exercises(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  image TEXT,
  bodyPart TEXT,
  primaryMuscles TEXT,
  secondaryMuscles TEXT,
  equipment TEXT,
  isCustom INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS routines(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  createdAt INTEGER,
  updatedAt INTEGER
);
CREATE TABLE IF NOT EXISTS routine_exercises(
  id TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL,
  exercise_id TEXT NOT NULL,
  order_index INTEGER DEFAULT 0,
  FOREIGN KEY(routine_id) REFERENCES routines(id),
  FOREIGN KEY(exercise_id) REFERENCES exercises(id)
);
CREATE TABLE IF NOT EXISTS routine_sets(
  id TEXT PRIMARY KEY,
  routine_exercise_id TEXT NOT NULL,
  reps INTEGER,
  peso REAL,
  FOREIGN KEY(routine_exercise_id) REFERENCES routine_exercises(id)
);
CREATE TABLE IF NOT EXISTS workouts(
  id TEXT PRIMARY KEY,
  routine_id TEXT,
  startedAt INTEGER,
  finishedAt INTEGER,
  durationSec INTEGER
);
CREATE TABLE IF NOT EXISTS workout_items(
  id TEXT PRIMARY KEY,
  workout_id TEXT NOT NULL,
  exercise_id TEXT,
  name TEXT,
  bodyPart TEXT,
  image TEXT,
  order_index INTEGER DEFAULT 0,
  FOREIGN KEY(workout_id) REFERENCES workouts(id)
);
CREATE TABLE IF NOT EXISTS workout_sets(
  id TEXT PRIMARY KEY,
  workout_item_id TEXT NOT NULL,
  reps INTEGER,
  peso REAL,
  done INTEGER DEFAULT 0,
  FOREIGN KEY(workout_item_id) REFERENCES workout_items(id)
);
`);

// Seed exercises from JSON if table empty
const count = db.prepare("SELECT COUNT(*) AS c FROM exercises").get().c;
if(count===0){
  const seed = JSON.parse(fs.readFileSync(new URL("./seed_exercises.json", import.meta.url)));
  const ins = db.prepare(`INSERT INTO exercises(id,name,image,bodyPart,primaryMuscles,secondaryMuscles,equipment,isCustom) VALUES(@id,@name,@image,@bodyPart,@primaryMuscles,@secondaryMuscles,@equipment,@isCustom)`);
  const tx = db.transaction((rows)=> rows.forEach(r=>ins.run(r)));
  tx(seed);
  console.log(`Seeded ${seed.length} exercises.`);
}

// --- Helpers ---
const now = ()=> Date.now();

function loadRoutineFull(id){
  const r = db.prepare("SELECT * FROM routines WHERE id=?").get(id);
  if(!r) return null;
  const exs = db.prepare(`
    SELECT re.id as rex_id, re.order_index, e.* 
    FROM routine_exercises re
    JOIN exercises e ON e.id = re.exercise_id
    WHERE re.routine_id = ?
    ORDER BY re.order_index ASC, re.id ASC
  `).all(id);
  const setsByRex = db.prepare("SELECT * FROM routine_sets WHERE routine_exercise_id = ? ORDER BY rowid ASC");
  const exercises = exs.map(row => ({
    id: row.rex_id,
    order_index: row.order_index,
    exercise: {
      id: row.id, name: row.name, image: row.image, bodyPart: row.bodyPart,
      primaryMuscles: row.primaryMuscles, secondaryMuscles: row.secondaryMuscles, equipment: row.equipment
    },
    sets: setsByRex.all(row.rex_id).map(s=>({ id:s.id, reps:s.reps, peso:s.peso }))
  }));
  return { id:r.id, name:r.name, createdAt:r.createdAt, updatedAt:r.updatedAt, exercises };
}

// --- API ---
app.get("/api/health", (req,res)=> res.json({ ok:true }));

// Exercises
app.get("/api/exercises/groups", (req,res)=>{
  const rows = db.prepare("SELECT DISTINCT bodyPart AS g FROM exercises WHERE bodyPart IS NOT NULL AND bodyPart<>'' ORDER BY g").all();
  res.json(rows.map(r=>r.g));
});
app.get("/api/exercises", (req,res)=>{
  const { q="", group="*" } = req.query;
  let sql = "SELECT * FROM exercises WHERE 1=1";
  const params = {};
  if(group && group !== "*"){ sql += " AND bodyPart LIKE @g"; params.g = `%${group}%`; }
  if(q){ sql += " AND LOWER(name) LIKE @q"; params.q = `%${String(q).toLowerCase()}%`; }
  sql += " ORDER BY name ASC LIMIT 300";
  const rows = db.prepare(sql).all(params);
  res.json(rows);
});
app.post("/api/exercises", (req,res)=>{
  const p = req.body || {};
  if(!p.name) return res.status(400).json({ error:"name required" });
  const ex = { id: "cus_"+nanoid(8), name:p.name.trim(), image:p.image||"", bodyPart:p.bodyPart||"", primaryMuscles:p.primaryMuscles||"", secondaryMuscles:p.secondaryMuscles||"", equipment:p.equipment||"", isCustom:1 };
  db.prepare(`INSERT INTO exercises(id,name,image,bodyPart,primaryMuscles,secondaryMuscles,equipment,isCustom) VALUES(@id,@name,@image,@bodyPart,@primaryMuscles,@secondaryMuscles,@equipment,@isCustom)`).run(ex);
  res.json(ex);
});

// Routines
app.get("/api/routines", (req,res)=>{
  const rows = db.prepare("SELECT * FROM routines ORDER BY updatedAt DESC").all();
  const mapExercises = db.prepare("SELECT COUNT(*) AS c, routine_id FROM routine_exercises GROUP BY routine_id").all().reduce((acc,r)=> (acc[r.routine_id]=r.c, acc), {});
  res.json(rows.map(r=>({ ...r, exercises: Array.from({ length: mapExercises[r.id]||0 }, ()=>({ sets:[] })) })));
});

app.post("/api/routines", (req,res)=>{
  const id = "rut_"+nanoid(8);
  const ts = now();
  db.prepare("INSERT INTO routines(id,name,createdAt,updatedAt) VALUES(?,?,?,?)").run(id, req.body.name || "Rutina", ts, ts);
  res.json(loadRoutineFull(id));
});

app.get("/api/routines/:id", (req,res)=>{
  const out = loadRoutineFull(req.params.id);
  if(!out) return res.status(404).json({ error:"not found" });
  res.json(out);
});

app.put("/api/routines/:id", (req,res)=>{
  const id = req.params.id;
  const body = req.body||{};
  if(body.name){
    db.prepare("UPDATE routines SET name=?, updatedAt=? WHERE id=?").run(body.name, now(), id);
  }
  if(Array.isArray(body.exercises)){
    const tx = db.transaction((list)=>{
      list.forEach(ex=>{
        if(Array.isArray(ex.sets)){
          ex.sets.forEach(s=>{
            if(s.id){
              db.prepare("UPDATE routine_sets SET reps=?, peso=? WHERE id=?").run(s.reps, s.peso, s.id);
            }
          });
        }
      });
      db.prepare("UPDATE routines SET updatedAt=? WHERE id=?").run(now(), id);
    });
    tx(body.exercises);
  }
  res.json(loadRoutineFull(id));
});

app.delete("/api/routines/:id/exercises/:rexId", (req,res)=>{
  const { id, rexId } = req.params;
  const tx = db.transaction(()=>{
    db.prepare("DELETE FROM routine_sets WHERE routine_exercise_id=?").run(rexId);
    db.prepare("DELETE FROM routine_exercises WHERE id=? AND routine_id=?").run(rexId, id);
    db.prepare("UPDATE routines SET updatedAt=? WHERE id=?").run(now(), id);
  });
  tx();
  res.json({ ok:true });
});

app.post("/api/routines/:id/exercises", (req,res)=>{
  const { id } = req.params;
  const { exerciseId } = req.body||{};
  if(!exerciseId) return res.status(400).json({ error:"exerciseId required" });
  const rexId = "rex_"+nanoid(8);
  const order = db.prepare("SELECT COALESCE(MAX(order_index),0)+1 AS o FROM routine_exercises WHERE routine_id=?").get(id).o;
  const tx = db.transaction(()=>{
    db.prepare("INSERT INTO routine_exercises(id,routine_id,exercise_id,order_index) VALUES(?,?,?,?)").run(rexId, id, exerciseId, order);
    db.prepare("UPDATE routines SET updatedAt=? WHERE id=?").run(now(), id);
  });
  tx();
  res.json(loadRoutineFull(id));
});

app.post("/api/routines/:id/exercises/:rexId/sets", (req,res)=>{
  const { id, rexId } = req.params;
  const setId = "set_"+nanoid(8);
  db.prepare("INSERT INTO routine_sets(id,routine_exercise_id,reps,peso) VALUES(?,?,?,?)").run(setId, rexId, req.body?.reps ?? null, req.body?.peso ?? null);
  db.prepare("UPDATE routines SET updatedAt=? WHERE id=?").run(now(), id);
  res.json({ id:setId });
});

app.delete("/api/routines/:id/exercises/:rexId/sets/:setId", (req,res)=>{
  const { id, rexId, setId } = req.params;
  db.prepare("DELETE FROM routine_sets WHERE id=? AND routine_exercise_id=?").run(setId, rexId);
  db.prepare("UPDATE routines SET updatedAt=? WHERE id=?").run(now(), id);
  res.json({ ok:true });
});

// Workouts
app.post("/api/workouts", (req,res)=>{
  const s = req.body||{};
  const id = "wo_"+nanoid(8);
  const tx = db.transaction(()=>{
    db.prepare("INSERT INTO workouts(id,routine_id,startedAt,finishedAt,durationSec) VALUES(?,?,?,?,?)")
      .run(id, s.routineId, s.startedAt, s.finishedAt, s.durationSec);
    (s.items||[]).forEach((it, idx)=>{
      const wi = "wi_"+nanoid(8);
      db.prepare("INSERT INTO workout_items(id,workout_id,exercise_id,name,bodyPart,image,order_index) VALUES(?,?,?,?,?,?,?)")
        .run(wi, id, it.exerciseId, it.name, it.bodyPart, it.image, idx);
      (it.sets||[]).forEach(st=>{
        db.prepare("INSERT INTO workout_sets(id,workout_item_id,reps,peso,done) VALUES(?,?,?,?,?)")
          .run("ws_"+nanoid(8), wi, st.reps, st.peso, st.done ? 1 : 0);
      });
    });
  });
  tx();
  res.json({ id });
});

// Marks (PRs)
app.get("/api/marks", (req,res)=>{
  // PR por ejercicio: mayor peso (y, en empate, mayor reps)
  const rows = db.prepare(`
    WITH ranked AS (
      SELECT wi.exercise_id, wi.name, wi.bodyPart, wi.image, ws.peso, ws.reps,
             ROW_NUMBER() OVER (
               PARTITION BY wi.exercise_id
               ORDER BY (ws.peso IS NULL) ASC, ws.peso DESC, (ws.reps IS NULL) ASC, ws.reps DESC
             ) AS rn
      FROM workout_sets ws
      JOIN workout_items wi ON wi.id = ws.workout_item_id
    )
    SELECT exercise_id, name, bodyPart, image, peso AS pr_weight, COALESCE(reps,0) AS reps_at_pr
    FROM ranked WHERE rn=1
    ORDER BY name ASC
  `).all();
  res.json(rows);
});

app.listen(PORT, ()=> console.log(`GymBuddy server running on :${PORT}`));
