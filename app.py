from flask import Flask, request, jsonify, render_template
from pymongo import MongoClient
from datetime import datetime
import requests

app = Flask(__name__)

# ---------------- MONGODB CONNECTION ----------------

client = MongoClient(
    "mongodb+srv://krishajpatel4879_db_user:fPbQwlzu9pBL2rRV@recoverai.ovasqcl.mongodb.net/recoverydb"
)

db = client["recoverydb"]

patients_collection = db["patients"]
checkins_collection = db["checkins"]

print("MongoDB Connected Successfully")

# ---------------- HOME PAGE ----------------

@app.route("/")
def home():
    return render_template("index.html")


# ---------------- SAVE PATIENT ----------------

@app.route("/save_patient", methods=["POST"])
def save_patient():

    try:
        data = request.json

        patient = {
            "name": data.get("name"),
            "age": data.get("age"),
            "procedure": data.get("procedure"),
            "doctor": data.get("doctor"),
            "discharge_date": data.get("date"),
            "created_at": datetime.now()
        }

        patients_collection.insert_one(patient)

        return jsonify({
            "status": "success",
            "message": "Patient saved"
        })

    except Exception as e:
        print("Error saving patient:", e)

        return jsonify({
            "status": "error",
            "message": "Failed to save patient"
        })


# ---------------- CHAT LOGIC ----------------

import requests

@app.route("/chat", methods=["POST"])
def chat():

    try:

        message = request.json["message"]

        system_prompt = """
        You are RecoverAI, a compassionate recovery assistant.
        Detect symptoms and assign risk.
        """

        response = requests.post(
            "https://api.anthropic.com/v1/messages",

            headers={
                "x-api-key": "sk-ant-xxxxx",
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json"
            },

            json={
                "model": "claude-sonnet-4-20250514",
                "max_tokens": 300,
                "system": system_prompt,
                "messages": [
                    {
                        "role": "user",
                        "content": message
                    }
                ]
            }
        )

        print("STATUS:", response.status_code)
        print("RESPONSE:", response.text)

        if response.status_code != 200:

            return jsonify({
                "reply": "AI service temporarily unavailable.",
                "risk": "low"
            })

        data = response.json()

        reply = data["content"][0]["text"]

        msg_lower = message.lower()

        if "fever" in msg_lower:
            risk = "high"

        elif "vomiting" in msg_lower:
            risk = "high"

        elif "pain" in msg_lower:
            risk = "moderate"

        else:
            risk = "low"

        return jsonify({
            "reply": reply,
            "risk": risk
        })

    except Exception as e:

        print("Chat error:", e)

        return jsonify({
            "reply": "System error occurred",
            "risk": "low"
        })

# ---------------- SAVE CHECKIN ----------------

@app.route("/save_checkin", methods=["POST"])
def save_checkin():

    try:
        data = request.json

        checkin = {
            "name": data.get("name"),
            "message": data.get("message"),
            "risk": data.get("risk"),
            "timestamp": datetime.now()
        }

        checkins_collection.insert_one(checkin)

        return jsonify({
            "status": "success",
            "message": "Check-in saved"
        })

    except Exception as e:

        print("Checkin error:", e)

        return jsonify({
            "status": "error"
        })


# ---------------- RUN SERVER ----------------

if __name__ == "__main__":
    app.run(debug=True)