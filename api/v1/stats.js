// ACERVIS: Stats & Analytics API (v3.1.0)
// GET /api/v1/stats — Global dashboard overview (super admin)
// GET /api/v1/stats?institution_id=xxx — Institution-specific dashboard
import { handlePreflight, error } from './_lib/cors.js';
import { getDb } from './_lib/db.js';
import { authenticateInstitution, verifySuperAdmin } from './_lib/auth.js';

export default async function handler(req, res) {
  handlePreflight(req, res, 'GET, OPTIONS');

  if (req.method !== 'GET') return error(res, 'ACV_405', 'Method not allowed', 405);

  try {
    const sql = getDb();
    const institution = await authenticateInstitution(req);
    const isSuperAdmin = verifySuperAdmin(req);
    const { institution_id } = req.query;

    const instId = institution?.id || institution_id;

    // ── Global overview (super admin only) ──
    if (!instId) {
      if (!isSuperAdmin) return error(res, 'ACV_401', 'Super Admin access required for global stats', 401);

      const [totals] = await sql`
        SELECT
          (SELECT COUNT(*) FROM institutions) AS total_institutions,
          (SELECT COUNT(*) FROM institutions WHERE is_active = TRUE) AS active_institutions,
          (SELECT COUNT(*) FROM credentials) AS total_credentials,
          (SELECT COUNT(*) FROM credentials WHERE status = 'active') AS active_credentials,
          (SELECT COUNT(*) FROM credentials WHERE status = 'revoked') AS revoked_credentials,
          (SELECT COUNT(*) FROM credentials WHERE status = 'suspended') AS suspended_credentials,
          (SELECT COUNT(*) FROM transcripts) AS total_transcripts,
          (SELECT COUNT(*) FROM transcripts WHERE status = 'active') AS active_transcripts,
          (SELECT COUNT(*) FROM verification_requests) AS total_verifications,
          (SELECT COUNT(*) FROM verification_requests WHERE created_at > NOW() - INTERVAL '24 hours') AS verifications_24h
      `;

      // Monthly credential issuance (last 12 months)
      const monthlyTrend = await sql`
        SELECT TO_CHAR(DATE_TRUNC('month', issued_at), 'YYYY-MM') AS month,
          COUNT(*) AS count
        FROM credentials
        WHERE issued_at > NOW() - INTERVAL '12 months'
        GROUP BY DATE_TRUNC('month', issued_at)
        ORDER BY month
      `;

      // Top institutions by issuance
      const topInstitutions = await sql`
        SELECT i.name, i.short_code, COUNT(c.id) AS issued_count
        FROM institutions i
        LEFT JOIN credentials c ON c.institution_id = i.id
        GROUP BY i.id, i.name, i.short_code
        ORDER BY issued_count DESC LIMIT 10
      `;

      // Recent activity (last 20 audit logs)
      const recentActivity = await sql`
        SELECT al.*, i.name AS actor_name
        FROM audit_logs al
        LEFT JOIN institutions i ON al.actor_id = i.id
        ORDER BY al.created_at DESC LIMIT 20
      `;

      // Status breakdown
      const statusBreakdown = await sql`
        SELECT status, COUNT(*) AS count FROM credentials GROUP BY status
      `;

      return res.status(200).json({
        totals,
        monthly_trend: monthlyTrend,
        top_institutions: topInstitutions,
        recent_activity: recentActivity,
        status_breakdown: statusBreakdown,
        timestamp: new Date().toISOString()
      });
    }

    // ── Institution-specific stats ──
    const [info] = await sql`SELECT * FROM institutions WHERE id = ${instId}`;
    if (!info) return error(res, 'ACV_404', 'Institution not found', 404);

    const [totals] = await sql`
      SELECT
        (SELECT COUNT(*) FROM credentials WHERE institution_id = ${instId}) AS total_credentials,
        (SELECT COUNT(*) FROM credentials WHERE institution_id = ${instId} AND status = 'active') AS active_credentials,
        (SELECT COUNT(*) FROM credentials WHERE institution_id = ${instId} AND status = 'revoked') AS revoked_credentials,
        (SELECT COUNT(*) FROM credentials WHERE institution_id = ${instId} AND status = 'suspended') AS suspended_credentials,
        (SELECT COUNT(*) FROM transcripts WHERE institution_id = ${instId}) AS total_transcripts,
        (SELECT COUNT(*) FROM transcripts WHERE institution_id = ${instId} AND status = 'active') AS active_transcripts,
        (SELECT COUNT(*) FROM credentials WHERE institution_id = ${instId} AND issued_at > NOW() - INTERVAL '30 days') AS issued_30d,
        (SELECT COUNT(*) FROM credentials WHERE institution_id = ${instId} AND issued_at > NOW() - INTERVAL '7 days') AS issued_7d
    `;

    // Monthly trend (last 6 months)
    const monthlyTrend = await sql`
      SELECT TO_CHAR(DATE_TRUNC('month', issued_at), 'YYYY-MM') AS month, COUNT(*) AS count
      FROM credentials WHERE institution_id = ${instId} AND issued_at > NOW() - INTERVAL '6 months'
      GROUP BY DATE_TRUNC('month', issued_at) ORDER BY month
    `;

    // Top courses
    const topCourses = await sql`
      SELECT course_name, degree_type, COUNT(*) AS count
      FROM credentials WHERE institution_id = ${instId}
      GROUP BY course_name, degree_type ORDER BY count DESC LIMIT 10
    `;

    // Recent credentials
    const recent = await sql`
      SELECT ncn, student_name, course_name, status, issued_at
      FROM credentials WHERE institution_id = ${instId}
      ORDER BY issued_at DESC LIMIT 10
    `;

    return res.status(200).json({
      institution: { id: info.id, name: info.name, short_code: info.short_code, type: info.type },
      quota: { total: info.issuance_quota, used: info.issued_count, remaining: info.issuance_quota - info.issued_count },
      totals,
      monthly_trend: monthlyTrend,
      top_courses: topCourses,
      recent_credentials: recent,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('ACV_STATS_ERROR:', err);
    return error(res, 'ACV_500', 'Internal server error', 500);
  }
}
