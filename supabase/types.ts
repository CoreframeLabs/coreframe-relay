export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      _prisma_migrations: {
        Row: {
          applied_steps_count: number
          checksum: string
          finished_at: string | null
          id: string
          logs: string | null
          migration_name: string
          rolled_back_at: string | null
          started_at: string
        }
        Insert: {
          applied_steps_count?: number
          checksum: string
          finished_at?: string | null
          id: string
          logs?: string | null
          migration_name: string
          rolled_back_at?: string | null
          started_at?: string
        }
        Update: {
          applied_steps_count?: number
          checksum?: string
          finished_at?: string | null
          id?: string
          logs?: string | null
          migration_name?: string
          rolled_back_at?: string | null
          started_at?: string
        }
        Relationships: []
      }
      Account: {
        Row: {
          access_token: string | null
          expires_at: number | null
          id: string
          id_token: string | null
          provider: string
          providerAccountId: string
          refresh_token: string | null
          scope: string | null
          session_state: string | null
          token_type: string | null
          type: string
          userId: string
        }
        Insert: {
          access_token?: string | null
          expires_at?: number | null
          id: string
          id_token?: string | null
          provider: string
          providerAccountId: string
          refresh_token?: string | null
          scope?: string | null
          session_state?: string | null
          token_type?: string | null
          type: string
          userId: string
        }
        Update: {
          access_token?: string | null
          expires_at?: number | null
          id?: string
          id_token?: string | null
          provider?: string
          providerAccountId?: string
          refresh_token?: string | null
          scope?: string | null
          session_state?: string | null
          token_type?: string | null
          type?: string
          userId?: string
        }
        Relationships: [
          {
            foreignKeyName: "Account_userId_fkey"
            columns: ["userId"]
            isOneToOne: false
            referencedRelation: "User"
            referencedColumns: ["id"]
          },
        ]
      }
      ApiKey: {
        Row: {
          createdAt: string
          expiresAt: string | null
          hashedKey: string
          id: string
          lastUsedAt: string | null
          name: string
          teamId: string
          updatedAt: string
        }
        Insert: {
          createdAt?: string
          expiresAt?: string | null
          hashedKey: string
          id: string
          lastUsedAt?: string | null
          name: string
          teamId: string
          updatedAt?: string
        }
        Update: {
          createdAt?: string
          expiresAt?: string | null
          hashedKey?: string
          id?: string
          lastUsedAt?: string | null
          name?: string
          teamId?: string
          updatedAt?: string
        }
        Relationships: [
          {
            foreignKeyName: "ApiKey_teamId_fkey"
            columns: ["teamId"]
            isOneToOne: false
            referencedRelation: "Team"
            referencedColumns: ["id"]
          },
        ]
      }
      ApprovalRequest: {
        Row: {
          approvedBy: string | null
          createdAt: string
          expiresAt: string
          gateRuleId: string
          id: string
          inngestRunId: string | null
          payload: Json
          rejectedBy: string | null
          requestId: string
          resolvedAt: string | null
          riskLevel: Database["public"]["Enums"]["RiskLevel"]
          status: Database["public"]["Enums"]["ApprovalStatus"]
          teamId: string
        }
        Insert: {
          approvedBy?: string | null
          createdAt?: string
          expiresAt: string
          gateRuleId: string
          id: string
          inngestRunId?: string | null
          payload: Json
          rejectedBy?: string | null
          requestId: string
          resolvedAt?: string | null
          riskLevel: Database["public"]["Enums"]["RiskLevel"]
          status?: Database["public"]["Enums"]["ApprovalStatus"]
          teamId: string
        }
        Update: {
          approvedBy?: string | null
          createdAt?: string
          expiresAt?: string
          gateRuleId?: string
          id?: string
          inngestRunId?: string | null
          payload?: Json
          rejectedBy?: string | null
          requestId?: string
          resolvedAt?: string | null
          riskLevel?: Database["public"]["Enums"]["RiskLevel"]
          status?: Database["public"]["Enums"]["ApprovalStatus"]
          teamId?: string
        }
        Relationships: [
          {
            foreignKeyName: "ApprovalRequest_gateRuleId_fkey"
            columns: ["gateRuleId"]
            isOneToOne: false
            referencedRelation: "GateRule"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ApprovalRequest_teamId_fkey"
            columns: ["teamId"]
            isOneToOne: false
            referencedRelation: "Team"
            referencedColumns: ["id"]
          },
        ]
      }
      AuditLog: {
        Row: {
          actor: string
          createdAt: string
          event: string
          id: string
          metadata: Json | null
          target: string | null
          teamId: string
        }
        Insert: {
          actor: string
          createdAt?: string
          event: string
          id: string
          metadata?: Json | null
          target?: string | null
          teamId: string
        }
        Update: {
          actor?: string
          createdAt?: string
          event?: string
          id?: string
          metadata?: Json | null
          target?: string | null
          teamId?: string
        }
        Relationships: [
          {
            foreignKeyName: "AuditLog_teamId_fkey"
            columns: ["teamId"]
            isOneToOne: false
            referencedRelation: "Team"
            referencedColumns: ["id"]
          },
        ]
      }
      DeliveryLog: {
        Row: {
          attemptCount: number
          createdAt: string
          deliveredAt: string | null
          id: string
          latencyMs: number | null
          payloadSizeB: number | null
          requestId: string
          responseCode: number | null
          routeId: string
          sourceIp: string | null
          status: Database["public"]["Enums"]["DeliveryStatus"]
        }
        Insert: {
          attemptCount?: number
          createdAt?: string
          deliveredAt?: string | null
          id: string
          latencyMs?: number | null
          payloadSizeB?: number | null
          requestId: string
          responseCode?: number | null
          routeId: string
          sourceIp?: string | null
          status?: Database["public"]["Enums"]["DeliveryStatus"]
        }
        Update: {
          attemptCount?: number
          createdAt?: string
          deliveredAt?: string | null
          id?: string
          latencyMs?: number | null
          payloadSizeB?: number | null
          requestId?: string
          responseCode?: number | null
          routeId?: string
          sourceIp?: string | null
          status?: Database["public"]["Enums"]["DeliveryStatus"]
        }
        Relationships: [
          {
            foreignKeyName: "DeliveryLog_routeId_fkey"
            columns: ["routeId"]
            isOneToOne: false
            referencedRelation: "Route"
            referencedColumns: ["id"]
          },
        ]
      }
      DlqItem: {
        Row: {
          attemptCount: number
          createdAt: string
          expiresAt: string
          failReason: string
          id: string
          payload: Json | null
          payloadKey: string | null
          requestId: string
          retriedAt: string | null
          routeId: string
        }
        Insert: {
          attemptCount: number
          createdAt?: string
          expiresAt: string
          failReason: string
          id: string
          payload?: Json | null
          payloadKey?: string | null
          requestId: string
          retriedAt?: string | null
          routeId: string
        }
        Update: {
          attemptCount?: number
          createdAt?: string
          expiresAt?: string
          failReason?: string
          id?: string
          payload?: Json | null
          payloadKey?: string | null
          requestId?: string
          retriedAt?: string | null
          routeId?: string
        }
        Relationships: [
          {
            foreignKeyName: "DlqItem_routeId_fkey"
            columns: ["routeId"]
            isOneToOne: false
            referencedRelation: "Route"
            referencedColumns: ["id"]
          },
        ]
      }
      GateRule: {
        Row: {
          active: boolean
          condition: Json
          createdAt: string
          description: string | null
          id: string
          name: string
          riskLevel: Database["public"]["Enums"]["RiskLevel"]
          teamId: string
          timeoutMins: number
          updatedAt: string
        }
        Insert: {
          active?: boolean
          condition: Json
          createdAt?: string
          description?: string | null
          id: string
          name: string
          riskLevel?: Database["public"]["Enums"]["RiskLevel"]
          teamId: string
          timeoutMins?: number
          updatedAt: string
        }
        Update: {
          active?: boolean
          condition?: Json
          createdAt?: string
          description?: string | null
          id?: string
          name?: string
          riskLevel?: Database["public"]["Enums"]["RiskLevel"]
          teamId?: string
          timeoutMins?: number
          updatedAt?: string
        }
        Relationships: [
          {
            foreignKeyName: "GateRule_teamId_fkey"
            columns: ["teamId"]
            isOneToOne: false
            referencedRelation: "Team"
            referencedColumns: ["id"]
          },
        ]
      }
      Invitation: {
        Row: {
          allowedDomains: string[] | null
          createdAt: string
          email: string | null
          expires: string
          id: string
          invitedBy: string
          role: Database["public"]["Enums"]["Role"]
          sentViaEmail: boolean
          teamId: string
          token: string
          updatedAt: string
        }
        Insert: {
          allowedDomains?: string[] | null
          createdAt?: string
          email?: string | null
          expires: string
          id: string
          invitedBy: string
          role?: Database["public"]["Enums"]["Role"]
          sentViaEmail?: boolean
          teamId: string
          token: string
          updatedAt?: string
        }
        Update: {
          allowedDomains?: string[] | null
          createdAt?: string
          email?: string | null
          expires?: string
          id?: string
          invitedBy?: string
          role?: Database["public"]["Enums"]["Role"]
          sentViaEmail?: boolean
          teamId?: string
          token?: string
          updatedAt?: string
        }
        Relationships: [
          {
            foreignKeyName: "Invitation_invitedBy_fkey"
            columns: ["invitedBy"]
            isOneToOne: false
            referencedRelation: "User"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "Invitation_teamId_fkey"
            columns: ["teamId"]
            isOneToOne: false
            referencedRelation: "Team"
            referencedColumns: ["id"]
          },
        ]
      }
      jackson_index: {
        Row: {
          id: number
          key: string
          storeKey: string
        }
        Insert: {
          id?: number
          key: string
          storeKey: string
        }
        Update: {
          id?: number
          key?: string
          storeKey?: string
        }
        Relationships: [
          {
            foreignKeyName: "jackson_index_storeKey_fkey"
            columns: ["storeKey"]
            isOneToOne: false
            referencedRelation: "jackson_store"
            referencedColumns: ["key"]
          },
        ]
      }
      jackson_store: {
        Row: {
          createdAt: string
          iv: string | null
          key: string
          modifiedAt: string | null
          namespace: string | null
          tag: string | null
          value: string
        }
        Insert: {
          createdAt?: string
          iv?: string | null
          key: string
          modifiedAt?: string | null
          namespace?: string | null
          tag?: string | null
          value: string
        }
        Update: {
          createdAt?: string
          iv?: string | null
          key?: string
          modifiedAt?: string | null
          namespace?: string | null
          tag?: string | null
          value?: string
        }
        Relationships: []
      }
      jackson_ttl: {
        Row: {
          expiresAt: number
          key: string
        }
        Insert: {
          expiresAt: number
          key: string
        }
        Update: {
          expiresAt?: number
          key?: string
        }
        Relationships: []
      }
      PasswordReset: {
        Row: {
          createdAt: string
          email: string
          expiresAt: string
          id: number
          token: string
          updatedAt: string
        }
        Insert: {
          createdAt?: string
          email: string
          expiresAt: string
          id?: number
          token: string
          updatedAt: string
        }
        Update: {
          createdAt?: string
          email?: string
          expiresAt?: string
          id?: number
          token?: string
          updatedAt?: string
        }
        Relationships: []
      }
      Price: {
        Row: {
          amount: number | null
          billingScheme: string
          created: string
          currency: string
          id: string
          metadata: Json
          serviceId: string
          type: string
        }
        Insert: {
          amount?: number | null
          billingScheme: string
          created: string
          currency: string
          id: string
          metadata: Json
          serviceId: string
          type: string
        }
        Update: {
          amount?: number | null
          billingScheme?: string
          created?: string
          currency?: string
          id?: string
          metadata?: Json
          serviceId?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "Price_serviceId_fkey"
            columns: ["serviceId"]
            isOneToOne: false
            referencedRelation: "Service"
            referencedColumns: ["id"]
          },
        ]
      }
      Route: {
        Row: {
          createdAt: string
          destination: string
          id: string
          maxRetries: number
          name: string
          slug: string
          status: Database["public"]["Enums"]["RouteStatus"]
          teamId: string
          updatedAt: string
        }
        Insert: {
          createdAt?: string
          destination: string
          id: string
          maxRetries?: number
          name: string
          slug: string
          status?: Database["public"]["Enums"]["RouteStatus"]
          teamId: string
          updatedAt: string
        }
        Update: {
          createdAt?: string
          destination?: string
          id?: string
          maxRetries?: number
          name?: string
          slug?: string
          status?: Database["public"]["Enums"]["RouteStatus"]
          teamId?: string
          updatedAt?: string
        }
        Relationships: [
          {
            foreignKeyName: "Route_teamId_fkey"
            columns: ["teamId"]
            isOneToOne: false
            referencedRelation: "Team"
            referencedColumns: ["id"]
          },
        ]
      }
      Service: {
        Row: {
          created: string
          createdAt: string
          description: string
          features: string[] | null
          id: string
          image: string
          name: string
          updatedAt: string
        }
        Insert: {
          created: string
          createdAt?: string
          description: string
          features?: string[] | null
          id: string
          image: string
          name: string
          updatedAt?: string
        }
        Update: {
          created?: string
          createdAt?: string
          description?: string
          features?: string[] | null
          id?: string
          image?: string
          name?: string
          updatedAt?: string
        }
        Relationships: []
      }
      Session: {
        Row: {
          expires: string
          id: string
          sessionToken: string
          userId: string
        }
        Insert: {
          expires: string
          id: string
          sessionToken: string
          userId: string
        }
        Update: {
          expires?: string
          id?: string
          sessionToken?: string
          userId?: string
        }
        Relationships: [
          {
            foreignKeyName: "Session_userId_fkey"
            columns: ["userId"]
            isOneToOne: false
            referencedRelation: "User"
            referencedColumns: ["id"]
          },
        ]
      }
      Subscription: {
        Row: {
          active: boolean
          cancelAt: string | null
          createdAt: string
          customerId: string
          endDate: string
          id: string
          priceId: string
          startDate: string
          updatedAt: string
        }
        Insert: {
          active?: boolean
          cancelAt?: string | null
          createdAt?: string
          customerId: string
          endDate: string
          id: string
          priceId: string
          startDate: string
          updatedAt?: string
        }
        Update: {
          active?: boolean
          cancelAt?: string | null
          createdAt?: string
          customerId?: string
          endDate?: string
          id?: string
          priceId?: string
          startDate?: string
          updatedAt?: string
        }
        Relationships: []
      }
      Team: {
        Row: {
          billingId: string | null
          billingProvider: string | null
          createdAt: string
          defaultRole: Database["public"]["Enums"]["Role"]
          domain: string | null
          id: string
          name: string
          slug: string
          updatedAt: string
        }
        Insert: {
          billingId?: string | null
          billingProvider?: string | null
          createdAt?: string
          defaultRole?: Database["public"]["Enums"]["Role"]
          domain?: string | null
          id: string
          name: string
          slug: string
          updatedAt?: string
        }
        Update: {
          billingId?: string | null
          billingProvider?: string | null
          createdAt?: string
          defaultRole?: Database["public"]["Enums"]["Role"]
          domain?: string | null
          id?: string
          name?: string
          slug?: string
          updatedAt?: string
        }
        Relationships: []
      }
      TeamMember: {
        Row: {
          createdAt: string
          id: string
          role: Database["public"]["Enums"]["Role"]
          teamId: string
          updatedAt: string
          userId: string
        }
        Insert: {
          createdAt?: string
          id: string
          role?: Database["public"]["Enums"]["Role"]
          teamId: string
          updatedAt?: string
          userId: string
        }
        Update: {
          createdAt?: string
          id?: string
          role?: Database["public"]["Enums"]["Role"]
          teamId?: string
          updatedAt?: string
          userId?: string
        }
        Relationships: [
          {
            foreignKeyName: "TeamMember_teamId_fkey"
            columns: ["teamId"]
            isOneToOne: false
            referencedRelation: "Team"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "TeamMember_userId_fkey"
            columns: ["userId"]
            isOneToOne: false
            referencedRelation: "User"
            referencedColumns: ["id"]
          },
        ]
      }
      User: {
        Row: {
          createdAt: string
          email: string
          emailVerified: string | null
          id: string
          image: string | null
          invalid_login_attempts: number
          lockedAt: string | null
          name: string
          password: string | null
          updatedAt: string
        }
        Insert: {
          createdAt?: string
          email: string
          emailVerified?: string | null
          id: string
          image?: string | null
          invalid_login_attempts?: number
          lockedAt?: string | null
          name: string
          password?: string | null
          updatedAt?: string
        }
        Update: {
          createdAt?: string
          email?: string
          emailVerified?: string | null
          id?: string
          image?: string | null
          invalid_login_attempts?: number
          lockedAt?: string | null
          name?: string
          password?: string | null
          updatedAt?: string
        }
        Relationships: []
      }
      VerificationToken: {
        Row: {
          expires: string
          identifier: string
          token: string
        }
        Insert: {
          expires: string
          identifier: string
          token: string
        }
        Update: {
          expires?: string
          identifier?: string
          token?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      ApprovalStatus: "PENDING" | "APPROVED" | "REJECTED" | "TIMED_OUT"
      DeliveryStatus: "QUEUED" | "DELIVERED" | "RETRYING" | "FAILED" | "DLQ"
      RiskLevel: "LOW" | "MEDIUM" | "HIGH"
      Role: "ADMIN" | "OWNER" | "MEMBER"
      RouteStatus: "ACTIVE" | "PAUSED" | "FAILING"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      ApprovalStatus: ["PENDING", "APPROVED", "REJECTED", "TIMED_OUT"],
      DeliveryStatus: ["QUEUED", "DELIVERED", "RETRYING", "FAILED", "DLQ"],
      RiskLevel: ["LOW", "MEDIUM", "HIGH"],
      Role: ["ADMIN", "OWNER", "MEMBER"],
      RouteStatus: ["ACTIVE", "PAUSED", "FAILING"],
    },
  },
} as const

