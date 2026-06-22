# Taste (Continuously Learned by [CommandCode][cmd])

[cmd]: https://commandcode.ai/

# architecture
- Transcripts use multi-subject structure — each transcript contains multiple subject rows (course_code, score, grade, credits, semester) rather than being a flat credential type. Confidence: 0.75
- Use automated deployment scripts (ethers.js/Hardhat) for smart contract deployment to Polygon Amoy rather than manual Remix deployment. Confidence: 0.70
- Use token-based authentication (12-char institutional tokens in headers) rather than JWT session-based auth for admin endpoints. Confidence: 0.70

# csv-format
- For combined credential+transcript batch CSV, use two-section format with alternating STUDENT/SUBJECT type markers — STUDENT rows fill student-level columns, SUBJECT rows fill course-level columns, grouped by name+matric. Confidence: 0.70
- All batch operations (credential issue, transcript issue, batch verification) should accept CSV upload as the primary input format — JSON is impractical for Nigerian universities with thousands of students. Confidence: 0.75

# workflow
- Ask thorough requirements-scoping questions before starting implementation — prefer comprehensive discovery over quick starts. Confidence: 0.75

